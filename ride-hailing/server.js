/**
 * Ride-Hailing App — Express + Mongoose + Socket.io
 * Serves Customer App (/customer) and Driver App (/driver)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

// ─── Global crash protection ──────────────────────────────────────────────────
// Catch any unhandled error/rejection so the server never exits unexpectedly.
// Log the problem and keep running — the request that caused it will simply
// time-out or receive a 500, which is far better than a full process crash.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught Exception (server kept alive):', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled Promise Rejection (server kept alive):', reason);
});

const express = require('express');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const webpush  = require('web-push');

// ── 2. APP & SERVER INITIALIZATION ───────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

// ── 3. IMMEDIATE HEALTHCHECK ROUTES (before any middleware) ──────────────
// Deployment probes hit /api and /health immediately on startup.
// These must return 200 with zero dependencies — no DB, no middleware.
app.get('/api',    (_req, res) => res.status(200).json({ status: 'ok' }));
app.get('/health', (_req, res) => res.status(200).send('OK'));

// ── 4. MIDDLEWARES & STATIC FILES ─────────────────────────────────────────
app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
// Resolve the public directory absolutely — works in any CWD or spawn context.
const PUBLIC_DIR = path.resolve(__dirname, 'public');
app.use(express.static(PUBLIC_DIR));

// Pre-read HTML pages synchronously at startup so we never rely on sendFile's
// stream/path behaviour in Cloud Run containers.  If a file is missing the
// server refuses to start with a clear error rather than silently 500-ing.
const fs = require('fs');
function loadPage(file) {
  const full = path.resolve(PUBLIC_DIR, file);
  try {
    return fs.readFileSync(full, 'utf8');
  } catch (e) {
    // Return a minimal fallback so a missing file never crashes startup or 500s the healthcheck
    console.error(`[startup] Warning: cannot load ${full}: ${e.message}`);
    return `<!DOCTYPE html><html><body><h1>MyRide</h1><p>Page unavailable.</p></body></html>`;
  }
}
const PAGES = {
  customer: loadPage('customer.html'),
  driver:   loadPage('driver.html'),
  admin:    loadPage('admin.html'),
  download: loadPage('download.html'),
};

const JWT_SECRET = process.env.JWT_SECRET || 'ride-hailing-secret-fallback';
let dbConnected  = false;

// Encode raw special characters in username/password without double-encoding
// already-percent-encoded sequences (mirrors the existing api-server approach).
function normalizeMongoUri(uri) {
  const schemeEnd = uri.indexOf('://');
  if (schemeEnd === -1) return uri;
  const authorityStart     = schemeEnd + 3;
  const userInfoSeparator  = uri.lastIndexOf('@');
  if (userInfoSeparator < authorityStart) return uri;
  const userInfo           = uri.slice(authorityStart, userInfoSeparator);
  const passwordSeparator  = userInfo.indexOf(':');
  if (passwordSeparator === -1) return uri;
  const username = userInfo.slice(0, passwordSeparator);
  const password = userInfo.slice(passwordSeparator + 1);
  const normalizeCredential = (s) =>
    s.replace(/%[0-9a-f]{2}|./giu, (ch) =>
      ch.startsWith('%') ? ch.toUpperCase() : encodeURIComponent(ch)
    );
  const normalized = `${normalizeCredential(username)}:${normalizeCredential(password)}`;
  return `${uri.slice(0, authorityStart)}${normalized}${uri.slice(userInfoSeparator)}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Mongoose Schemas
// ─────────────────────────────────────────────────────────────────────────────

const userSchema = new mongoose.Schema({
  name:    { type: String, required: true, trim: true },
  email:   { type: String, unique: true, sparse: true, lowercase: true, trim: true }, // optional
  password:{ type: String, required: true },
  phone:   { type: String, default: '', trim: true },
  role:    { type: String, enum: ['customer', 'driver'], default: 'customer' },
  vehicleType:  { type: String, enum: ['Bike', 'Rickshaw', 'Car Mini', 'Car AC', ''], default: '' },
  vehicleModel: { type: String, default: '' },
  vehiclePlate: { type: String, default: '' },
  isOnline: { type: Boolean, default: false },
  isAdmin:  { type: Boolean, default: false },
  currentLocation: {
    lat: { type: Number, default: 0 },
    lng: { type: Number, default: 0 }
  },
  rating:       { type: Number, default: 5.0 },
  totalRides:   { type: Number, default: 0 },
  emergencyContacts: [{
    name:  { type: String, default: '' },
    phone: { type: String, required: true }
  }],
  otpCode:   { type: String,  default: null },
  otpExpiry: { type: Date,    default: null },
  // Admin management
  accountStatus:   { type: String, enum: ['active','pending','suspended','blocked'], default: 'active' },
  suspendReason:   { type: String, default: '' },
  suspendedAt:     { type: Date,   default: null },
  // Driver verification documents (URL strings)
  profilePhoto:    { type: String, default: '' },
  cnicFront:       { type: String, default: '' },
  cnicBack:        { type: String, default: '' },
  licensePhoto:    { type: String, default: '' },
  vehicleRegPhoto: { type: String, default: '' }
}, { timestamps: true });

const rideSchema = new mongoose.Schema({
  passenger: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driver:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  pickupLocation: {
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, default: 'Pickup Point' }
  },
  dropoffLocation: {                // primary stop (first drop) — kept for driver-app compat
    lat:     { type: Number, default: 0 },
    lng:     { type: Number, default: 0 },
    address: { type: String, default: 'Dropoff Point' }
  },
  dropoffLocations: [{              // full ordered list of all stops
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, default: 'Stop' }
  }],
  fare:        { type: Number, required: true },
  distance:    { type: Number, default: 0 },
  status: {
    type: String,
    enum: ['requested', 'accepted', 'arrived', 'in-progress', 'completed', 'cancelled'],
    default: 'requested'
  },
  driverLocation: {
    lat: { type: Number, default: null },
    lng: { type: Number, default: null }
  },
  vehicleType:   { type: String, default: 'Car Mini' },
  notes:         { type: String, default: '' },
  paymentMethod: { type: String, enum: ['cash', 'easypaisa', 'jazzcash', 'wallet'], default: 'cash' },
  mobileAccount: { type: String, default: '' },
  counterOffers: [{
    driver:       { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    driverName:   String,
    vehicleModel: String,
    vehiclePlate: String,
    rating:       Number,
    price:        Number,
    type:         { type: String, enum: ['accept', 'counter'], default: 'accept' },
    timestamp:    { type: Date, default: Date.now }
  }],
  driverRating: { type: Number, default: null },
  driverReview: { type: String,  default: '' }
}, { timestamps: true });

const walletSchema = new mongoose.Schema({
  user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },
  balance: { type: Number, default: 0 },
  transactions: [{
    amount:        Number,
    type:          { type: String, enum: ['credit', 'debit'] },
    description:   String,
    paymentMethod: { type: String, default: '' },
    mobileAccount: { type: String, default: '' },
    createdAt:     { type: Date, default: Date.now }
  }]
}, { timestamps: true });

const sosSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  location: { lat: Number, lng: Number },
  message:  { type: String, default: 'SOS Emergency Alert!' },
  ride:     { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },
  resolved: { type: Boolean, default: false }
}, { timestamps: true });

const ticketSchema = new mongoose.Schema({
  user:       { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  role:       { type: String, enum: ['customer','driver'], required: true },
  subject:    { type: String, required: true, trim: true },
  message:    { type: String, required: true, trim: true },
  status:     { type: String, enum: ['open','resolved'], default: 'open' },
  adminReply: { type: String, default: '' },
  repliedAt:  { type: Date,    default: null },
  readByUser: { type: Boolean, default: false }
}, { timestamps: true });

const paymentSchema = new mongoose.Schema({
  driver:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  trxId:           { type: String, required: true, trim: true },
  amount:          { type: Number, required: true },
  vehicleCategory: { type: String, required: true },
  paymentType:     { type: String, enum: ['jazzcash','easypaisa','bank'], default: 'jazzcash' },
  status:          { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  adminNote:       { type: String, default: '' },
  submittedDate:   { type: String, required: true }   // 'YYYY-MM-DD' UTC date, for uniqueness check
}, { timestamps: true });

// One TRX submission per driver per calendar day
paymentSchema.index({ driver: 1, submittedDate: 1 }, { unique: true });

// Key-value settings store
const settingsSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true });

// Web-Push subscriptions per driver
const pushSubSchema = new mongoose.Schema({
  user:         { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  endpoint:     { type: String, required: true },
  keys:         { p256dh: String, auth: String },
  updatedAt:    { type: Date, default: Date.now }
});
pushSubSchema.index({ user: 1, endpoint: 1 }, { unique: true });

const User     = mongoose.model('User',     userSchema);
const Ride     = mongoose.model('Ride',     rideSchema);
const Wallet   = mongoose.model('Wallet',   walletSchema);
const SOS      = mongoose.model('SOS',      sosSchema);
const Payment  = mongoose.model('Payment',  paymentSchema);
const Ticket   = mongoose.model('Ticket',   ticketSchema);
const Settings = mongoose.model('Settings', settingsSchema);
const PushSub  = mongoose.model('PushSub',  pushSubSchema);

// ─────────────────────────────────────────────────────────────────────────────
// Auth Middleware
// ─────────────────────────────────────────────────────────────────────────────

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization token required' });
  }
  try {
    req.user = jwt.verify(auth.slice(7), JWT_SECRET);
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Admin Middleware (two flavours)
// ─────────────────────────────────────────────────────────────────────────────

// Legacy: used by /api/payments/* routes (needs authMiddleware first)
async function adminMiddleware(req, res, next) {
  try {
    const user = await User.findById(req.user.id).select('isAdmin');
    if (!user || !user.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    next();
  } catch (err) { res.status(500).json({ error: err.message }); }
}

// New: self-contained — verifies admin JWT claim (no DB lookup)
function adminJwt(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) return res.status(401).json({ error: 'Admin token required' });
  try {
    const payload = jwt.verify(auth.slice(7), JWT_SECRET);
    if (!payload.isAdmin) return res.status(403).json({ error: 'Admin access required' });
    req.admin = payload;
    next();
  } catch { return res.status(401).json({ error: 'Invalid or expired admin token' }); }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Routes
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone, role, vehicleType, vehicleModel, vehiclePlate,
            profilePhoto, licensePhoto, cnicFront, cnicBack } = req.body;
    if (!name || !password) return res.status(400).json({ error: 'Name and password are required' });
    if (!phone)             return res.status(400).json({ error: 'Phone number is required' });

    const resolvedEmail = email ? email.toLowerCase().trim() : null;

    if (resolvedEmail && await User.findOne({ email: resolvedEmail }))
      return res.status(409).json({ error: 'Email already registered' });
    if (phone && await User.findOne({ phone: phone.trim() }))
      return res.status(409).json({ error: 'Phone number already registered' });

    const hash = await bcrypt.hash(password, 12);
    const resolvedRole = role || 'customer';
    const user = await User.create({
      name,
      email:         resolvedEmail  || undefined,
      phone:         phone?.trim()  || '',
      password:      hash,
      role:          resolvedRole,
      accountStatus: resolvedRole === 'driver' ? 'pending' : 'active',
      vehicleType:   vehicleType    || '',
      vehicleModel:  vehicleModel   || '',
      vehiclePlate:  vehiclePlate   || '',
      profilePhoto:  profilePhoto   || '',
      licensePhoto:  licensePhoto   || '',
      cnicFront:     cnicFront      || '',
      cnicBack:      cnicBack       || ''
    });
    await Wallet.create({ user: user._id, balance: 0, transactions: [] });

    const token = jwt.sign(
      { id: user._id, email: user.email || '', role: user.role, name: user.name },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email || '', phone: user.phone,
              role: user.role, accountStatus: user.accountStatus,
              vehicleType: user.vehicleType,
              vehicleModel: user.vehicleModel, vehiclePlate: user.vehiclePlate }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    // Accept { identifier, password } (new) or { email, password } (legacy)
    const identifier = (req.body.identifier || req.body.email || '').trim();
    const { password } = req.body;
    if (!identifier || !password) return res.status(400).json({ error: 'Phone/email and password required' });

    // Look up by email if it contains @, otherwise by phone
    const user = identifier.includes('@')
      ? await User.findOne({ email: identifier.toLowerCase() })
      : await User.findOne({ phone: identifier });

    if (!user) return res.status(404).json({ error: 'No account found with this phone number or email' });
    if (!(await bcrypt.compare(password, user.password)))
      return res.status(401).json({ error: 'Incorrect password. Please try again.' });
    const token = jwt.sign(
      { id: user._id, email: user.email || '', role: user.role, name: user.name },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email || '', phone: user.phone,
              role: user.role, accountStatus: user.accountStatus,
              profilePhoto: user.profilePhoto || '',
              vehicleType: user.vehicleType,
              vehicleModel: user.vehicleModel, vehiclePlate: user.vehiclePlate, rating: user.rating }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Forgot Password (OTP-based) ───────────────────────────────────────────

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });
    const user = await User.findOne({ phone: phone.trim() });
    if (!user) return res.status(404).json({ error: 'No account found with this phone number' });

    const otp = String(Math.floor(1000 + Math.random() * 9000));   // 4-digit
    const expiry = new Date(Date.now() + 10 * 60 * 1000);           // 10 min
    await User.updateOne({ _id: user._id }, { otpCode: otp, otpExpiry: expiry });

    console.log(`[OTP] ${user.name} (${phone}): ${otp}`);  // simulate SMS
    // In production: integrate Twilio / Infobip to send real SMS
    res.json({ success: true, otp, hint: 'OTP returned for demo — in production this is SMS-only' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
  try {
    const { phone, otp, newPassword } = req.body;
    if (!phone || !otp || !newPassword)
      return res.status(400).json({ error: 'Phone, OTP, and new password required' });
    const user = await User.findOne({ phone: phone.trim(), otpCode: otp });
    if (!user) return res.status(400).json({ error: 'Invalid or expired OTP' });
    if (user.otpExpiry < new Date()) return res.status(400).json({ error: 'OTP has expired — request a new one' });
    const hash = await bcrypt.hash(newPassword, 12);
    await User.updateOne({ _id: user._id }, { password: hash, otpCode: null, otpExpiry: null });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ── Emergency Contacts ─────────────────────────────────────────────────────

app.get('/api/auth/emergency-contacts', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('emergencyContacts');
    res.json(user?.emergencyContacts || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/auth/emergency-contacts', authMiddleware, async (req, res) => {
  try {
    const contacts = (req.body.contacts || [])
      .filter(c => c.phone && c.phone.trim())
      .slice(0, 2)
      .map(c => ({ name: (c.name || '').trim(), phone: c.phone.trim() }));
    await User.updateOne({ _id: req.user.id }, { emergencyContacts: contacts });
    res.json({ success: true, contacts });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  try {
    const user = await User.findById(req.user.id).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ride Routes
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/rides', authMiddleware, async (req, res) => {
  try {
    const { pickupLocation, dropoffLocation, dropoffLocations, fare, distance, vehicleType, notes, paymentMethod, mobileAccount } = req.body;
    if (!pickupLocation || !fare) {
      return res.status(400).json({ error: 'Pickup and fare are required' });
    }
    // Resolve stops: prefer dropoffLocations array; fall back to single dropoffLocation
    const stops = Array.isArray(dropoffLocations) && dropoffLocations.length
      ? dropoffLocations
      : (dropoffLocation ? [dropoffLocation] : []);
    if (!stops.length) return res.status(400).json({ error: 'At least one dropoff stop is required' });

    const ride = await Ride.create({
      passenger:        req.user.id,
      pickupLocation,
      dropoffLocation:  stops[0],        // primary stop
      dropoffLocations: stops,
      fare,
      distance:      distance      || 0,
      vehicleType:   vehicleType   || 'Car Mini',
      notes:         notes         || '',
      paymentMethod: paymentMethod || 'cash',
      mobileAccount: mobileAccount || ''
    });

    // Broadcast to all online drivers via Socket.io
    const ridePayload = {
      id:               ride._id,
      pickupLocation:   ride.pickupLocation,
      dropoffLocation:  ride.dropoffLocation,
      dropoffLocations: ride.dropoffLocations,   // full multi-stop list
      fare:             ride.fare,
      distance:         ride.distance,
      vehicleType:      ride.vehicleType,
      paymentMethod:    ride.paymentMethod,
      notes:            ride.notes,
      createdAt:        ride.createdAt
    };
    io.to('drivers-online').emit('ride:new', ridePayload);

    // Also push a Web Push notification to subscribed active drivers (handles closed tabs)
    if (global._vapidPublicKey && dbConnected) {
      const area    = ride.pickupLocation?.address || 'Nearby';
      const fareStr = `Rs ${(ride.fare || 0).toLocaleString()}`;
      const distStr = ride.distance ? ` · ${ride.distance.toFixed(1)} km` : '';
      const pushData = {
        title: '🚗 New Ride Request!',
        body:  `📍 ${area}\n💰 ${fareStr}${distStr}`,
        url:   '/driver'
      };
      // Fire-and-forget — don't block the HTTP response.
      // Only send to subscriptions belonging to active drivers (not customers,
      // not pending/suspended/blocked drivers).
      User.find({ role: 'driver', accountStatus: 'active' }).select('_id').lean()
        .then(activeDrivers => {
          const activeIds = activeDrivers.map(d => String(d._id));
          return PushSub.find({ user: { $in: activeIds } });
        })
        .then(subs => {
          subs.forEach(sub => {
            webpush.sendNotification(
              { endpoint: sub.endpoint, keys: sub.keys },
              JSON.stringify(pushData)
            ).catch(err => {
              // 410 Gone = subscription expired — clean it up
              if (err.statusCode === 410) PushSub.deleteOne({ _id: sub._id }).catch(() => {});
            });
          });
        })
        .catch(() => {});
    }

    res.status(201).json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides/available', authMiddleware, async (req, res) => {
  try {
    const rides = await Ride.find({ status: 'requested' })
      .populate('passenger', 'name phone rating')
      .sort({ createdAt: -1 });
    res.json(rides);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides/my', authMiddleware, async (req, res) => {
  try {
    const query = req.user.role === 'driver'
      ? { driver: req.user.id }
      : { passenger: req.user.id };
    const rides = await Ride.find(query)
      .populate('passenger driver', 'name phone vehicleType rating')
      .sort({ createdAt: -1 })
      .limit(20);
    res.json(rides);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/rides/:id', authMiddleware, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id)
      .populate('passenger driver', 'name phone vehicleType rating currentLocation');
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/rides/:id/accept', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can accept rides' });
    }
    const ride = await Ride.findOneAndUpdate(
      { _id: req.params.id, status: 'requested', driver: null },
      { $set: { driver: req.user.id, status: 'accepted' } },
      { new: true }
    ).populate('passenger', 'name phone');

    if (!ride) return res.status(409).json({ error: 'Ride no longer available' });

    // Fetch full driver profile for the acceptance payload
    const driverUser = await User.findById(req.user.id).select('name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');
    io.to(`ride:${ride._id}`).emit('ride:accepted', {
      rideId: ride._id,
      driver: {
        id:           req.user.id,
        name:         driverUser.name,
        phone:        driverUser.phone || '',
        vehicleType:  driverUser.vehicleType,
        vehicleModel: driverUser.vehicleModel || '',
        vehiclePlate: driverUser.vehiclePlate || '',
        rating:       driverUser.rating || 5.0,
        profilePhoto: driverUser.profilePhoto || ''
      }
    });
    io.to('drivers-online').emit('ride:taken', { rideId: ride._id });

    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const STATUS_TRANSITIONS = {
  'accepted':   ['arrived', 'cancelled'],
  'arrived':    ['in-progress'],
  'in-progress':['completed']
};

app.patch('/api/rides/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });

    const allowed = STATUS_TRANSITIONS[ride.status] || [];
    if (!allowed.includes(status)) {
      return res.status(400).json({ error: `Cannot transition from "${ride.status}" to "${status}"` });
    }
    ride.status = status;
    await ride.save();

    io.to(`ride:${ride._id}`).emit('ride:status', { rideId: ride._id, status });

    if (status === 'completed') {
      await Wallet.updateOne(
        { user: ride.passenger },
        { $inc: { balance: -ride.fare },
          $push: { transactions: { amount: ride.fare, type: 'debit', description: 'Ride fare' } } }
      );
      const earnings = +(ride.fare * 0.85).toFixed(2);
      await Wallet.updateOne(
        { user: ride.driver },
        { $inc: { balance: earnings },
          $push: { transactions: { amount: earnings, type: 'credit', description: 'Ride earnings' } } },
        { upsert: true }
      );
      await User.updateOne({ _id: ride.driver },    { $inc: { totalRides: 1 } });
      await User.updateOne({ _id: ride.passenger }, { $inc: { totalRides: 1 } });
    }

    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.patch('/api/rides/:id/cancel', authMiddleware, async (req, res) => {
  try {
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (!['requested', 'accepted'].includes(ride.status)) {
      return res.status(400).json({ error: 'Cannot cancel at this stage' });
    }
    ride.status = 'cancelled';
    await ride.save();
    io.to(`ride:${ride._id}`).emit('ride:status', { rideId: ride._id, status: 'cancelled' });
    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/counter — driver submits an offer or counter-offer
app.patch('/api/rides/:id/counter', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only' });
    const { price, type } = req.body;           // type: 'accept' | 'counter'
    if (!price || price < 1) return res.status(400).json({ error: 'Valid price required' });

    const ride = await Ride.findOne({ _id: req.params.id, status: 'requested' });
    if (!ride) return res.status(404).json({ error: 'Ride not available' });

    // Prevent duplicate offers from same driver
    const already = ride.counterOffers.some(o => String(o.driver) === String(req.user.id));
    if (already) return res.status(409).json({ error: 'You already sent an offer for this ride' });

    const driver = await User.findById(req.user.id).select('name vehicleModel vehiclePlate rating');
    const offer = {
      driver:       req.user.id,
      driverName:   driver.name,
      vehicleModel: driver.vehicleModel || '',
      vehiclePlate: driver.vehiclePlate || '',
      rating:       driver.rating || 5.0,
      price:        Number(price),
      type:         type === 'counter' ? 'counter' : 'accept',
      timestamp:    new Date()
    };
    ride.counterOffers.push(offer);
    await ride.save();

    // Emit updated offers list to the customer
    io.to(`ride:${ride._id}`).emit('ride:offers', ride.counterOffers.map(o => ({
      driverId:     String(o.driver),
      driverName:   o.driverName,
      vehicleModel: o.vehicleModel,
      vehiclePlate: o.vehiclePlate,
      rating:       o.rating,
      price:        o.price,
      type:         o.type,
      timestamp:    o.timestamp
    })));

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/accept-driver — customer selects a specific driver
app.patch('/api/rides/:id/accept-driver', authMiddleware, async (req, res) => {
  try {
    const { driverId } = req.body;
    if (!driverId) return res.status(400).json({ error: 'driverId required' });

    const ride = await Ride.findOneAndUpdate(
      { _id: req.params.id, passenger: req.user.id, status: 'requested', driver: null },
      { $set: { driver: driverId, status: 'accepted' } },
      { new: true }
    ).populate('passenger', 'name phone');
    if (!ride) return res.status(409).json({ error: 'Ride no longer available' });

    // Find the agreed price from the offer
    const offer = ride.counterOffers.find(o => String(o.driver) === String(driverId));
    if (offer && offer.price && offer.price !== ride.fare) {
      ride.fare = offer.price;
      await ride.save();
    }

    const driverUser = await User.findById(driverId).select('name phone vehicleType vehicleModel vehiclePlate rating profilePhoto');
    io.to(`ride:${ride._id}`).emit('ride:accepted', {
      rideId: ride._id,
      driver: {
        id:           String(driverId),
        name:         driverUser.name,
        phone:        driverUser.phone || '',
        vehicleType:  driverUser.vehicleType,
        vehicleModel: driverUser.vehicleModel || '',
        vehiclePlate: driverUser.vehiclePlate || '',
        rating:       driverUser.rating || 5.0,
        profilePhoto: driverUser.profilePhoto || ''
      }
    });
    io.to('drivers-online').emit('ride:taken', { rideId: ride._id });

    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/rides/:id/update-fare — customer raises their offer on a pending ride
app.patch('/api/rides/:id/update-fare', authMiddleware, async (req, res) => {
  try {
    const { fare } = req.body;
    if (!fare || fare < 1) return res.status(400).json({ error: 'Valid fare required' });

    const ride = await Ride.findOneAndUpdate(
      { _id: req.params.id, passenger: req.user.id, status: 'requested' },
      { $set: { fare: Number(fare) } },
      { new: true }
    );
    if (!ride) return res.status(404).json({ error: 'Ride not found or already accepted' });

    // Re-broadcast updated fare to all online drivers
    io.to('drivers-online').emit('ride:fare-updated', {
      id:   ride._id,
      fare: ride.fare
    });

    res.json(ride);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Wallet Routes
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/wallet', authMiddleware, async (req, res) => {
  try {
    let wallet = await Wallet.findOne({ user: req.user.id });
    if (!wallet) wallet = await Wallet.create({ user: req.user.id, balance: 0, transactions: [] });
    res.json(wallet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/wallet/add-funds', authMiddleware, async (req, res) => {
  try {
    const amount = Number(req.body.amount);
    if (!amount || amount <= 0) return res.status(400).json({ error: 'Valid amount required' });
    const { paymentMethod, mobileAccount } = req.body;
    const PM_LABELS = { easypaisa: 'EasyPaisa', jazzcash: 'JazzCash', bank: 'Bank Transfer', cash: 'Cash' };
    const pmLabel = PM_LABELS[paymentMethod] || 'Wallet top-up';
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user.id },
      { $inc: { balance: amount },
        $push: { transactions: {
          amount, type: 'credit',
          description: `Top-up via ${pmLabel}`,
          paymentMethod: paymentMethod || '',
          mobileAccount: mobileAccount || ''
        } } },
      { new: true, upsert: true }
    );
    res.json(wallet);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Payment Routes (Driver Wallet / TRX submission)
// ─────────────────────────────────────────────────────────────────────────────

// Daily earnings targets per vehicle category (PKR)
const DAILY_TARGETS = { 'Bike': 2500, 'Rickshaw': 4000, 'Car Mini': 5500, 'Car AC': 6500 };

// Helper: today's date string in UTC (YYYY-MM-DD)
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

// POST /api/payments/submit — driver submits daily TRX ID
app.post('/api/payments/submit', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can submit payments' });
    }
    const { trxId, amount, paymentType } = req.body;
    if (!trxId || !trxId.trim()) {
      return res.status(400).json({ error: 'TRX ID is required' });
    }
    if (!amount || Number(amount) <= 0) {
      return res.status(400).json({ error: 'A valid amount is required' });
    }

    const driver = await User.findById(req.user.id).select('vehicleType');
    if (!driver) return res.status(404).json({ error: 'Driver not found' });

    const dateStr = todayUTC();
    // Uniqueness: one submission per driver per day
    const existing = await Payment.findOne({ driver: req.user.id, submittedDate: dateStr });
    if (existing) {
      return res.status(409).json({ error: 'You have already submitted a payment for today. Wait for admin review before resubmitting.' });
    }

    const validTypes = ['jazzcash', 'easypaisa', 'bank'];
    const payment = await Payment.create({
      driver:          req.user.id,
      trxId:           trxId.trim(),
      amount:          Number(amount),
      paymentType:     validTypes.includes(paymentType) ? paymentType : 'jazzcash',
      vehicleCategory: driver.vehicleType || 'Car Mini',
      submittedDate:   dateStr
    });

    res.status(201).json(payment);
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ error: 'You have already submitted a payment for today.' });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/my — driver's own payment history
app.get('/api/payments/my', authMiddleware, async (req, res) => {
  try {
    const payments = await Payment.find({ driver: req.user.id })
      .sort({ createdAt: -1 })
      .limit(30);
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wallet/status — driver's wallet status vs daily target
app.get('/api/wallet/status', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers have a payment wallet status' });
    }
    const driver = await User.findById(req.user.id).select('vehicleType');
    const category = driver?.vehicleType || 'Car Mini';
    const target   = DAILY_TARGETS[category] || 5500;

    // Sum all approved payments ever
    const result = await Payment.aggregate([
      { $match: { driver: new mongoose.Types.ObjectId(req.user.id), status: 'approved' } },
      { $group: { _id: null, totalApproved: { $sum: '$amount' } } }
    ]);
    const totalApproved = result[0]?.totalApproved || 0;

    // Today's ride earnings: sum of 'Ride earnings' wallet credits for the current UTC day
    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todayEnd = new Date();
    todayEnd.setUTCHours(23, 59, 59, 999);

    const wallet = await Wallet.findOne({ user: req.user.id });
    const todayRideEarnings = wallet
      ? wallet.transactions
          .filter(t =>
            t.type === 'credit' &&
            t.description === 'Ride earnings' &&
            t.createdAt >= todayStart &&
            t.createdAt <= todayEnd
          )
          .reduce((sum, t) => sum + t.amount, 0)
      : 0;

    const remaining = Math.max(0, target - totalApproved - todayRideEarnings);

    // Today's submission (if any)
    const todayPayment = await Payment.findOne({ driver: req.user.id, submittedDate: todayUTC() });

    res.json({ category, target, totalApproved, todayRideEarnings, remaining, todayPayment: todayPayment || null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/pending — admin: list pending submissions
app.get('/api/payments/pending', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const payments = await Payment.find({ status: 'pending' })
      .populate('driver', 'name phone vehicleType')
      .sort({ createdAt: 1 });
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/payments/:id/approve — admin
app.patch('/api/payments/:id/approve', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.status !== 'pending') {
      return res.status(400).json({ error: `Payment is already ${payment.status}` });
    }
    payment.status    = 'approved';
    payment.adminNote = req.body.adminNote || '';
    await payment.save();
    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/payments/:id/reject — admin
app.patch('/api/payments/:id/reject', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Payment not found' });
    if (payment.status !== 'pending') {
      return res.status(400).json({ error: `Payment is already ${payment.status}` });
    }
    payment.status    = 'rejected';
    payment.adminNote = req.body.adminNote || '';
    await payment.save();
    res.json(payment);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/payments/history — admin: recently approved/rejected submissions
app.get('/api/payments/history', authMiddleware, adminMiddleware, async (req, res) => {
  try {
    const payments = await Payment.find({ status: { $in: ['approved', 'rejected'] } })
      .populate('driver', 'name phone vehicleType')
      .sort({ updatedAt: -1 })
      .limit(50);
    res.json(payments);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// SOS Route
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/sos', authMiddleware, async (req, res) => {
  try {
    const { location, message, rideId, driverInfo } = req.body;
    // Fetch user's emergency contacts for the alert
    const userDoc = await User.findById(req.user.id).select('emergencyContacts name phone');
    const sos = await SOS.create({
      user:     req.user.id,
      location: location || { lat: 0, lng: 0 },
      message:  message  || 'SOS Emergency Alert!',
      ride:     rideId   || null
    });
    const sosPayload = {
      sosId:             sos._id,
      userId:            req.user.id,
      userName:          req.user.name,
      userPhone:         userDoc?.phone || '',
      location, message, rideId,
      driverInfo:        driverInfo || null,
      emergencyContacts: userDoc?.emergencyContacts || [],
      ts: new Date().toISOString()
    };
    io.emit('sos:alert', sosPayload);
    io.to('admin-room').emit('sos:alert', sosPayload); // explicit to admin room
    res.status(201).json({
      success: true, sos,
      emergencyContacts: userDoc?.emergencyContacts || []
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Geocode Proxy — forwards to LocationIQ (if LOCATIONIQ_KEY set) or Nominatim
// Keeps API keys server-side and adds a proper User-Agent for Nominatim ToS.
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/geocode', async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q || q.length < 2) return res.json([]);

  try {
    const key = process.env.LOCATIONIQ_KEY;
    let url, headers = {};

    if (key) {
      // LocationIQ — superior Pakistani locality / neighbourhood data
      url = `https://us1.locationiq.com/v1/search` +
            `?key=${encodeURIComponent(key)}` +
            `&q=${encodeURIComponent(q)}` +
            `&format=json&limit=8&countrycodes=pk` +
            `&addressdetails=1&normalizeaddress=1&dedupe=1&namedetails=1`;
    } else {
      // Enhanced Nominatim fallback (OSM data, good for major Pakistani areas)
      url = `https://nominatim.openstreetmap.org/search` +
            `?q=${encodeURIComponent(q)}` +
            `&format=json&limit=8&countrycodes=pk` +
            `&addressdetails=1&dedupe=1&namedetails=1`;
      headers = {
        'User-Agent': 'MyRide-App/1.0 (ride-hailing)',
        'Accept-Language': 'en,ur'
      };
    }

    const r = await fetch(url, { headers, signal: AbortSignal.timeout(5000) });
    if (!r.ok) throw new Error(`Geocode upstream ${r.status}`);
    const data = await r.json();
    res.json(Array.isArray(data) ? data : []);
  } catch (err) {
    console.error('Geocode error:', err.message);
    res.json([]);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin Routes  (/api/admin/*)
// ─────────────────────────────────────────────────────────────────────────────

// POST /api/admin/login — env-credential login, returns admin JWT
app.post('/api/admin/login', (req, res) => {
  const { email, password } = req.body;
  const ADMIN_EMAIL = process.env.ADMIN_EMAIL    || 'admin@myride.com';
  const ADMIN_PASS  = process.env.ADMIN_PASSWORD || 'admin1234';
  if (!email || !password || email !== ADMIN_EMAIL || password !== ADMIN_PASS)
    return res.status(401).json({ error: 'Invalid admin credentials' });
  const token = jwt.sign({ isAdmin: true, email }, JWT_SECRET, { expiresIn: '12h' });
  res.json({ token, admin: { email } });
});

// GET /api/admin/stats — overview dashboard numbers
app.get('/api/admin/stats', adminJwt, async (req, res) => {
  try {
    const today = new Date(); today.setUTCHours(0, 0, 0, 0);
    const [totalDrivers, pendingDrivers, suspendedDrivers, totalPassengers,
           blockedPassengers, activeRides, pendingPayments, unresolvedSOS] =
      await Promise.all([
        User.countDocuments({ role: 'driver' }),
        User.countDocuments({ role: 'driver', accountStatus: 'pending' }),
        User.countDocuments({ role: 'driver', accountStatus: 'suspended' }),
        User.countDocuments({ role: 'customer' }),
        User.countDocuments({ role: 'customer', accountStatus: 'blocked' }),
        Ride.countDocuments({ status: { $in: ['requested','accepted','arrived','in-progress'] } }),
        Payment.countDocuments({ status: 'pending' }),
        SOS.countDocuments({ resolved: false })
      ]);
    const earningsAgg = await Payment.aggregate([
      { $match: { status: 'approved', updatedAt: { $gte: today } } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);
    res.json({
      totalDrivers, pendingDrivers, suspendedDrivers, totalPassengers,
      blockedPassengers, activeRides, pendingPayments, unresolvedSOS,
      todayEarnings: earningsAgg[0]?.total || 0
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/drivers?status=all|pending|approved|suspended|blocked
app.get('/api/admin/drivers', adminJwt, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { role: 'driver' };
    if (status && status !== 'all') filter.accountStatus = status;
    const drivers = await User.find(filter)
      .select('-password -otpCode -otpExpiry')
      .sort('-createdAt').limit(200);
    res.json(drivers);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/passengers?status=all|active|blocked
app.get('/api/admin/passengers', adminJwt, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = { role: 'customer' };
    if (status === 'blocked') filter.accountStatus = 'blocked';
    else if (status === 'active') filter.accountStatus = { $ne: 'blocked' };
    const passengers = await User.find(filter)
      .select('-password -otpCode -otpExpiry')
      .sort('-createdAt').limit(200);
    // Attach ride count to each passenger
    const withCounts = await Promise.all(passengers.map(async p => {
      const rideCount = await Ride.countDocuments({ passenger: p._id });
      return { ...p.toObject(), rideCount };
    }));
    res.json(withCounts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/users/:id/status — approve|suspend|block|unblock
app.patch('/api/admin/users/:id/status', adminJwt, async (req, res) => {
  try {
    const { action, reason } = req.body;
    let update = {};
    if      (action === 'approve')  update = { accountStatus: 'active',    suspendReason: '', suspendedAt: null };
    else if (action === 'suspend')  update = { accountStatus: 'suspended', suspendReason: reason || 'Temporary suspension', suspendedAt: new Date() };
    else if (action === 'block')    update = { accountStatus: 'blocked',   suspendReason: reason || 'Permanently blocked',  suspendedAt: new Date() };
    else if (action === 'unblock')  update = { accountStatus: 'active',    suspendReason: '', suspendedAt: null };
    else return res.status(400).json({ error: 'Invalid action' });

    const user = await User.findByIdAndUpdate(req.params.id, { ...update, isOnline: false }, { new: true }).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (action === 'suspend' || action === 'block')
      io.to(`user:${req.params.id}`).emit('account:suspended', { reason: reason || 'Account suspended' });
    if (action === 'approve' || action === 'unblock')
      io.to(`user:${req.params.id}`).emit('account:activated', {});

    res.json({ success: true, user });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/rides?status=active|completed|cancelled|all&date=YYYY-MM-DD
app.get('/api/admin/rides', adminJwt, async (req, res) => {
  try {
    const { status, date } = req.query;
    const filter = {};
    if (status === 'active') filter.status = { $in: ['requested','accepted','arrived','in-progress'] };
    else if (status && status !== 'all') filter.status = status;
    if (date) {
      const d = new Date(date); d.setUTCHours(0,0,0,0);
      const d2 = new Date(d);   d2.setUTCHours(23,59,59,999);
      filter.createdAt = { $gte: d, $lte: d2 };
    }
    const rides = await Ride.find(filter)
      .populate('passenger', 'name phone')
      .populate('driver',    'name phone vehicleModel vehiclePlate')
      .sort('-createdAt').limit(100);
    res.json(rides);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/sos?resolved=false|true|all
app.get('/api/admin/sos', adminJwt, async (req, res) => {
  try {
    const { resolved } = req.query;
    const filter = {};
    if (resolved === 'false') filter.resolved = false;
    else if (resolved === 'true') filter.resolved = true;
    const alerts = await SOS.find(filter)
      .populate('user', 'name phone role')
      .populate('ride')
      .sort('-createdAt').limit(50);
    res.json(alerts);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/sos/:id/resolve', adminJwt, async (req, res) => {
  try {
    await SOS.updateOne({ _id: req.params.id }, { resolved: true });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/payments?status=pending|approved|rejected|all
app.get('/api/admin/payments', adminJwt, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    const payments = await Payment.find(filter)
      .populate('driver', 'name phone vehicleType vehiclePlate')
      .sort('-createdAt').limit(100);
    res.json(payments);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/payments/:id/approve', adminJwt, async (req, res) => {
  try {
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Not found' });
    if (payment.status !== 'pending') return res.status(400).json({ error: `Already ${payment.status}` });
    payment.status = 'approved'; payment.adminNote = req.body.adminNote || '';
    await payment.save();
    io.to(`user:${payment.driver}`).emit('payment:approved', { amount: payment.amount });
    res.json({ success: true, payment });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/payments/:id/reject', adminJwt, async (req, res) => {
  try {
    const { reason } = req.body;
    const payment = await Payment.findById(req.params.id);
    if (!payment) return res.status(404).json({ error: 'Not found' });
    if (payment.status !== 'pending') return res.status(400).json({ error: `Already ${payment.status}` });
    payment.status = 'rejected'; payment.adminNote = reason || '';
    await payment.save();
    io.to(`user:${payment.driver}`).emit('payment:rejected', { reason: reason || 'Rejected' });
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Profile Photo Upload
// ─────────────────────────────────────────────────────────────────────────────

app.put('/api/auth/profile/photos', authMiddleware, async (req, res) => {
  try {
    const { profilePhoto, licensePhoto, cnicFront, cnicBack, vehicleRegPhoto } = req.body;
    const update = {};
    if (profilePhoto   !== undefined) update.profilePhoto   = profilePhoto;
    if (licensePhoto   !== undefined) update.licensePhoto   = licensePhoto;
    if (cnicFront      !== undefined) update.cnicFront      = cnicFront;
    if (cnicBack       !== undefined) update.cnicBack       = cnicBack;
    if (vehicleRegPhoto !== undefined) update.vehicleRegPhoto = vehicleRegPhoto;
    await User.updateOne({ _id: req.user.id }, update);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ride Review / Rating
// ─────────────────────────────────────────────────────────────────────────────

app.patch('/api/rides/:id/review', authMiddleware, async (req, res) => {
  try {
    const { rating, review } = req.body;
    if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be 1–5' });
    const ride = await Ride.findById(req.params.id);
    if (!ride) return res.status(404).json({ error: 'Ride not found' });
    if (String(ride.passenger) !== String(req.user.id)) return res.status(403).json({ error: 'Not your ride' });
    if (ride.status !== 'completed') return res.status(400).json({ error: 'Ride not completed' });
    if (ride.driverRating !== null) return res.status(409).json({ error: 'Already reviewed' });
    ride.driverRating = Number(rating);
    ride.driverReview = (review || '').trim();
    await ride.save();
    // Update driver average rating
    if (ride.driver) {
      const ratings = await Ride.find({ driver: ride.driver, driverRating: { $ne: null } }).select('driverRating');
      const avg = ratings.reduce((s, r) => s + r.driverRating, 0) / ratings.length;
      await User.updateOne({ _id: ride.driver }, { rating: +avg.toFixed(1), $inc: { totalRides: 0 } });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Support Tickets
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/support/my — user's own tickets with replies
app.get('/api/support/my', authMiddleware, async (req, res) => {
  try {
    const tickets = await Ticket.find({ user: req.user.id }).sort('-createdAt').limit(50);
    res.json(tickets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/support/my/read — mark all replied tickets as read for this user
app.patch('/api/support/my/read', authMiddleware, async (req, res) => {
  try {
    await Ticket.updateMany(
      { user: req.user.id, adminReply: { $ne: '' }, readByUser: false },
      { readByUser: true }
    );
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/wallet/summary — driver's wallet balance, monthly fee, bonus credits, ledger
app.get('/api/wallet/summary', authMiddleware, async (req, res) => {
  try {
    if (req.user.role !== 'driver') return res.status(403).json({ error: 'Drivers only' });
    const driver = await User.findById(req.user.id).select('vehicleType');
    const vehicleType = driver?.vehicleType || 'Car Mini';
    const monthlyFee  = TRIAL_AMOUNTS[vehicleType] || 4500;

    const wallet = await Wallet.findOne({ user: req.user.id });
    const balance      = wallet?.balance || 0;
    const transactions = wallet?.transactions || [];

    // Sum all bonus/promotional credits
    const totalBonus = transactions
      .filter(t => t.type === 'credit' &&
        (t.description?.toLowerCase().includes('bonus') ||
         t.description?.toLowerCase().includes('trial') ||
         t.description?.toLowerCase().includes('promotional')))
      .reduce((s, t) => s + t.amount, 0);

    // Recent ledger — last 40 entries newest first
    const ledger = [...transactions].reverse().slice(0, 40).map(t => ({
      amount: t.amount, type: t.type, description: t.description, createdAt: t.createdAt
    }));

    // Today's payment submission
    const todayPayment = await Payment.findOne({ driver: req.user.id, submittedDate: todayUTC() });

    res.json({ balance, monthlyFee, totalBonus, vehicleType, ledger, todayPayment: todayPayment || null });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/support/ticket', authMiddleware, async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!subject?.trim() || !message?.trim()) return res.status(400).json({ error: 'Subject and message required' });
    const ticket = await Ticket.create({
      user: req.user.id, role: req.user.role || 'customer',
      subject: subject.trim(), message: message.trim()
    });
    res.status(201).json(ticket);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/support', adminJwt, async (req, res) => {
  try {
    const { status } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    const tickets = await Ticket.find(filter)
      .populate('user', 'name phone email role')
      .sort('-createdAt').limit(100);
    res.json(tickets);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.patch('/api/admin/support/:id/resolve', adminJwt, async (req, res) => {
  try {
    const { adminReply } = req.body;
    const ticket = await Ticket.findById(req.params.id).select('user subject');
    if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
    await Ticket.updateOne({ _id: req.params.id }, {
      status: 'resolved', adminReply: adminReply || '',
      repliedAt: new Date(), readByUser: false
    });
    // Push real-time notification to the user
    if (adminReply?.trim() && ticket.user) {
      io.to(`user:${ticket.user}`).emit('support:replied', {
        ticketId: String(ticket._id), subject: ticket.subject, reply: adminReply
      });
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Ratings & Reviews (admin)
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/admin/ratings', adminJwt, async (req, res) => {
  try {
    const rides = await Ride.find({ driverRating: { $ne: null } })
      .populate('passenger', 'name phone')
      .populate('driver', 'name phone vehiclePlate rating')
      .select('driverRating driverReview createdAt fare vehicleType')
      .sort('-createdAt').limit(100);
    res.json(rides);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Admin: Grant Free Trial Credit
// ─────────────────────────────────────────────────────────────────────────────

const TRIAL_AMOUNTS = { 'Bike': 2000, 'Rickshaw': 3000, 'Car Mini': 4500, 'Car AC': 6500 };

app.post('/api/admin/drivers/grant-trial', adminJwt, async (req, res) => {
  try {
    const { driverIds } = req.body; // array of user IDs
    if (!Array.isArray(driverIds) || !driverIds.length)
      return res.status(400).json({ error: 'driverIds array required' });

    const drivers = await User.find({ _id: { $in: driverIds }, role: 'driver' }).select('vehicleType name');
    const results = [];
    for (const driver of drivers) {
      const amount = TRIAL_AMOUNTS[driver.vehicleType] || 4500;
      await Wallet.findOneAndUpdate(
        { user: driver._id },
        { $inc: { balance: amount },
          $push: { transactions: { amount, type: 'credit', description: '1-Month Promotional Bonus Credit' } } },
        { upsert: true, new: true }
      );
      results.push({ id: driver._id, name: driver.name, amount });
    }
    res.json({ success: true, credited: results.length, results });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Settings Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/settings/payment — public: drivers/customers read admin account numbers
app.get('/api/settings/payment', async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'payment_accounts' });
    res.json(doc?.value || { jazzcash: { title: '', number: '' }, easypaisa: { title: '', number: '' }, bank: { name: '', title: '', iban: '' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/settings — admin: read all settings
app.get('/api/admin/settings', adminJwt, async (req, res) => {
  try {
    const doc = await Settings.findOne({ key: 'payment_accounts' });
    res.json(doc?.value || { jazzcash: { title: '', number: '' }, easypaisa: { title: '', number: '' }, bank: { name: '', title: '', iban: '' } });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PATCH /api/admin/settings — admin: save payment account details
app.patch('/api/admin/settings', adminJwt, async (req, res) => {
  try {
    const { jazzcash, easypaisa, bank } = req.body;
    const value = {
      jazzcash:  { title: jazzcash?.title  || '', number: jazzcash?.number || '' },
      easypaisa: { title: easypaisa?.title || '', number: easypaisa?.number || '' },
      bank:      { name:  bank?.name  || '', title: bank?.title || '', iban: bank?.iban || '' }
    };
    await Settings.findOneAndUpdate(
      { key: 'payment_accounts' },
      { key: 'payment_accounts', value },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    res.json({ success: true, value });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/admin/daily-income — last 30 days grouped by date
app.get('/api/admin/daily-income', adminJwt, async (req, res) => {
  try {
    const since = new Date(); since.setDate(since.getDate() - 30); since.setUTCHours(0,0,0,0);
    const payments = await Payment.find({ status: 'approved', updatedAt: { $gte: since } })
      .populate('driver', 'name vehicleType');
    const byDate = {};
    payments.forEach(p => {
      const d = (p.updatedAt || p.createdAt).toISOString().slice(0,10);
      if (!byDate[d]) byDate[d] = { date: d, total: 0, count: 0 };
      byDate[d].total += p.amount; byDate[d].count++;
    });
    res.json(Object.values(byDate).sort((a, b) => b.date.localeCompare(a.date)));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─────────────────────────────────────────────────────────────────────────────
// Web Push Routes
// ─────────────────────────────────────────────────────────────────────────────

// GET /api/push/vapid-key — return the public VAPID key to the client
app.get('/api/push/vapid-key', (_req, res) => {
  if (!global._vapidPublicKey) return res.status(503).json({ error: 'Push not configured' });
  res.json({ publicKey: global._vapidPublicKey });
});

// POST /api/push/subscribe — save (or update) a driver's push subscription
// Only active/approved drivers may register; customers are rejected.
app.post('/api/push/subscribe', authMiddleware, async (req, res) => {
  try {
    // Drivers only
    if (req.user.role !== 'driver') {
      return res.status(403).json({ error: 'Only drivers can register push subscriptions' });
    }

    // Confirm driver is active in DB (not pending/suspended/blocked)
    const driver = await User.findById(req.user.id).select('role accountStatus');
    if (!driver || driver.role !== 'driver') {
      return res.status(403).json({ error: 'Driver account not found' });
    }
    if (driver.accountStatus !== 'active') {
      return res.status(403).json({ error: 'Only active driver accounts can register push subscriptions' });
    }

    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth) {
      return res.status(400).json({ error: 'endpoint and keys (p256dh, auth) are required' });
    }

    // Validate endpoint is from a known browser push-service origin.
    // This prevents SSRF: the server would otherwise make outbound requests
    // to any attacker-supplied HTTPS URL via webpush.sendNotification().
    const ALLOWED_PUSH_ORIGINS = [
      'https://fcm.googleapis.com',              // Chrome, Edge, Opera, Samsung
      'https://updates.push.services.mozilla.com', // Firefox
      'https://push.services.mozilla.com',        // Firefox (newer)
      'https://web.push.apple.com',               // Safari 16+
      'https://api.push.apple.com',               // Safari (alternate)
    ];
    let parsedEndpoint;
    try { parsedEndpoint = new URL(endpoint); } catch {
      return res.status(400).json({ error: 'endpoint must be a valid URL' });
    }
    if (parsedEndpoint.protocol !== 'https:') {
      return res.status(400).json({ error: 'endpoint must use HTTPS' });
    }
    const endpointOrigin = parsedEndpoint.origin;
    const isAllowed = ALLOWED_PUSH_ORIGINS.some(
      allowed => endpointOrigin === allowed || endpointOrigin.endsWith('.' + new URL(allowed).hostname)
    );
    if (!isAllowed) {
      return res.status(400).json({ error: 'endpoint is not from a supported browser push service' });
    }

    await PushSub.findOneAndUpdate(
      { user: req.user.id, endpoint },
      { user: req.user.id, endpoint, keys, updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────────────────────────────────────

// Health endpoints — deployment probe checks both /api and /api/health
app.get('/api', function(_req, res) { res.json({ status: 'ok' }); });
app.get('/api/health', function(_req, res) {
  res.json({ status: 'ok', db: dbConnected ? 'connected' : 'testing-mode', ts: new Date().toISOString() });
});

// Diagnostic: confirm PAGES are loaded in this container instance
app.get('/api/pages-status', function(_req, res) {
  res.json(Object.fromEntries(
    Object.entries(PAGES).map(([k, v]) => [k, { loaded: !!v, bytes: v ? v.length : 0 }])
  ));
});

// Page routes — serve pre-loaded HTML with explicit statements (no && chain).
function servePage(page) {
  return function(_req, res, next) {
    try {
      var content = PAGES[page];
      if (!content) {
        console.error('[servePage] PAGES["' + page + '"] is empty — startup load failed silently');
        return res.status(500).json({ error: 'page not loaded' });
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(content);
    } catch (err) {
      console.error('[servePage] error serving page "' + page + '":', err);
      next(err);
    }
  };
}
app.get('/customer', servePage('customer'));
app.get('/driver',   servePage('driver'));
app.get('/admin',    servePage('admin'));
app.get('/download', servePage('download'));
app.get('/',         servePage('customer'));

// Catch-all: serve customer SPA for any unmatched path (deep-link support).
app.use(function(_req, res) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(PAGES.customer);
});

// ── Express error handler — must have 4 params so Express treats it as error middleware ──
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  const status = err.status || err.statusCode || 500;
  const message = err.code === 'ENOENT' ? 'Page not found' : (err.message || 'Internal server error');
  console.error(`[Express error] ${status} — ${err.message}`);
  if (res.headersSent) return;
  res.status(status).json({ error: message });
});

// ─────────────────────────────────────────────────────────────────────────────
// Socket.io — Real-time Layer
// ─────────────────────────────────────────────────────────────────────────────

io.use((socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next(new Error('Authentication required'));
  try {
    socket.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    next(new Error('Invalid token'));
  }
});

io.on('connection', (socket) => {
  const user = socket.user;

  // ── Admin socket ───────────────────────────────────────────────────────────
  if (user.isAdmin) {
    socket.join('admin-room');
    console.log(`Admin socket connected [${user.email}]`);
    socket.on('disconnect', () => console.log(`Admin socket disconnected [${user.email}]`));
    return;  // no further driver/passenger setup
  }

  const { id, name, role } = user;
  console.log(`Socket connected: ${name} [${role}]`);

  // Join personal notification room
  socket.join(`user:${id}`);

  // ── Driver: restore room memberships from DB on every (re)connect ──────────
  // Socket.io rooms are process-memory only — they vanish on server restart.
  // We persist isOnline and active ride state to MongoDB so we can restore both
  // here without requiring the client to manually re-send status events first.
  if (role === 'driver') {
    Promise.all([
      User.findById(id).select('isOnline accountStatus').lean().catch(() => null),
      Ride.findOne({ driver: id, status: { $in: ['accepted', 'arrived', 'in-progress'] } })
          .select('_id').lean().catch(() => null)
    ]).then(([driver, activeRide]) => {
      // Restore online room — only if DB says online and account is active
      if (driver?.isOnline && driver.accountStatus === 'active') {
        socket.join('drivers-online');
      }
      // Re-join the active ride room so location updates reach the passenger
      if (activeRide) {
        socket.join(`ride:${activeRide._id}`);
        console.log(`Driver ${name} rejoined ride room ride:${activeRide._id} after reconnect`);
      }
    }).catch(() => {});
  }

  socket.on('ride:join',  (rideId) => socket.join(`ride:${rideId}`));
  socket.on('ride:leave', (rideId) => socket.leave(`ride:${rideId}`));

  // Driver sends location updates during a ride
  socket.on('driver:location', async ({ rideId, lat, lng }) => {
    if (role !== 'driver') return;
    if (rideId) {
      io.to(`ride:${rideId}`).emit('driver:location', { lat, lng });
      await Ride.updateOne({ _id: rideId }, { 'driverLocation.lat': lat, 'driverLocation.lng': lng }).catch(() => {});
    }
    await User.updateOne({ _id: id }, { 'currentLocation.lat': lat, 'currentLocation.lng': lng }).catch(() => {});
  });

  // Driver toggles online/offline
  socket.on('driver:status', async ({ isOnline }) => {
    if (role !== 'driver') return;
    if (isOnline) {
      const [driver, wallet] = await Promise.all([
        User.findById(id).select('accountStatus').catch(() => null),
        Wallet.findOne({ user: id }).select('balance').catch(() => null)
      ]);
      if (driver?.accountStatus === 'pending') {
        socket.emit('account:suspended', { reason: 'Your account is pending Admin approval. You will be notified once approved.' });
        return;
      }
      if (driver?.accountStatus === 'suspended' || driver?.accountStatus === 'blocked') {
        socket.emit('account:suspended', { reason: 'Your account has been suspended. Please contact Admin.' });
        return;
      }
      if (wallet && wallet.balance < 0) {
        socket.emit('account:suspended', {
          reason: `Insufficient wallet balance (Rs ${Math.abs(wallet.balance).toFixed(0)} due). Please recharge to go online.`
        });
        return;
      }
    }
    await User.updateOne({ _id: id }, { isOnline }).catch(() => {});
    if (isOnline) socket.join('drivers-online');
    else          socket.leave('drivers-online');
  });

  // Share live location (customer)
  socket.on('location:share', ({ lat, lng, rideId }) => {
    if (rideId) io.to(`ride:${rideId}`).emit('passenger:location', { lat, lng });
  });

  socket.on('disconnect', async () => {
    console.log(`Socket disconnected: ${name}`);
    if (role === 'driver') {
      await User.updateOne({ _id: id }, { isOnline: false }).catch(() => {});
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────────────────────────────────────

async function initVapidKeys() {
  // Prefer explicit env-var keys (set once, rotate rarely)
  const envPublic  = process.env.VAPID_PUBLIC_KEY;
  const envPrivate = process.env.VAPID_PRIVATE_KEY;
  const contactEmail = process.env.VAPID_EMAIL || 'mailto:admin@myride.app';

  if (envPublic && envPrivate) {
    webpush.setVapidDetails(contactEmail, envPublic, envPrivate);
    global._vapidPublicKey = envPublic;
    console.log('✓ VAPID keys loaded from environment');
    return;
  }

  // Fall back to keys stored in MongoDB Settings (persist across restarts)
  if (dbConnected) {
    try {
      let doc = await Settings.findOne({ key: 'vapid_keys' });
      if (!doc) {
        const keys = webpush.generateVAPIDKeys();
        doc = await Settings.create({ key: 'vapid_keys', value: keys });
        console.log('✓ VAPID keys generated and saved to DB');
      }
      const { publicKey, privateKey } = doc.value;
      webpush.setVapidDetails(contactEmail, publicKey, privateKey);
      global._vapidPublicKey = publicKey;
      console.log('✓ VAPID keys loaded from DB');
      return;
    } catch (err) {
      console.warn('⚠  Could not load/store VAPID keys from DB:', err.message);
    }
  }

  // Last resort: ephemeral keys (won't survive a restart — clients must re-subscribe)
  const keys = webpush.generateVAPIDKeys();
  webpush.setVapidDetails(contactEmail, keys.publicKey, keys.privateKey);
  global._vapidPublicKey = keys.publicKey;
  console.warn('⚠  Using ephemeral VAPID keys — set VAPID_PUBLIC_KEY & VAPID_PRIVATE_KEY env vars for persistence');
}

async function connectDatabase() {
  const rawUri = process.env.MONGO_URI;
  if (!rawUri) {
    console.warn('⚠  MONGO_URI not set — running in testing mode (data not persisted)');
    return;
  }
  const uri = normalizeMongoUri(rawUri);
  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 8000,
      heartbeatFrequencyMS: 10000,
    });
    dbConnected = true;
    console.log('✓ MongoDB Atlas connected');

    mongoose.connection.on('disconnected', () => {
      dbConnected = false;
      console.warn('⚠  MongoDB disconnected — Mongoose will auto-reconnect');
    });
    mongoose.connection.on('reconnected', () => {
      dbConnected = true;
      console.log('✓ MongoDB reconnected');
    });
    mongoose.connection.on('error', (mongoErr) => {
      console.error('MongoDB connection error:', mongoErr.message);
    });

    // Migrate email index to sparse (one-time, safe to re-run)
    try {
      const usersCol = mongoose.connection.collection('users');
      const idxs = await usersCol.indexes();
      const emailIdx = idxs.find(ix => ix.name === 'email_1');
      if (emailIdx && !emailIdx.sparse) {
        await usersCol.dropIndex('email_1');
        await usersCol.createIndex({ email: 1 }, { unique: true, sparse: true });
        console.log('✓ Email index migrated to sparse');
      }
    } catch (migrateErr) {
      console.warn('Email index migration skipped:', migrateErr.message);
    }
  } catch (err) {
    console.warn('⚠  MongoDB unavailable, running in testing mode:', err.message);
  }

  await initVapidKeys();
}

// Start DB connection in background — never blocks the HTTP server
connectDatabase().catch(err => console.error('connectDatabase error:', err));

// ─────────────────────────────────────────────────────────────────────────────
// Daily Subscription Deduction (runs at UTC midnight every day)
// ─────────────────────────────────────────────────────────────────────────────

const DAILY_SUB_RATES = { 'Bike': 67, 'Rickshaw': 100, 'Car Mini': 150, 'Car AC': 217 };

async function runDailyDeduction() {
  if (!dbConnected) return;
  console.log('⏰ Running daily subscription deduction…');
  try {
    const drivers = await User.find({ role: 'driver', accountStatus: 'active' }).select('_id vehicleType name');
    let count = 0;
    for (const driver of drivers) {
      const rate = DAILY_SUB_RATES[driver.vehicleType] || 150;
      await Wallet.findOneAndUpdate(
        { user: driver._id },
        { $inc: { balance: -rate },
          $push: { transactions: { amount: rate, type: 'debit',
            description: `Daily subscription (${driver.vehicleType || 'Car'})` } } },
        { upsert: true }
      ).catch(() => {});
      count++;
    }
    console.log(`✓ Daily deduction complete: ${count} drivers charged`);
  } catch (err) { console.error('Daily deduction error:', err.message); }
}

(function scheduleMidnightDeduction() {
  function msUntilMidnight() {
    const now = new Date();
    const midnight = new Date(now);
    midnight.setUTCHours(24, 0, 0, 0);
    return midnight - now;
  }
  function scheduleNext() {
    setTimeout(async () => {
      await runDailyDeduction();
      scheduleNext(); // re-schedule for next midnight
    }, msUntilMidnight());
  }
  scheduleNext();
  console.log(`⏰ Daily deduction scheduled (next run at UTC midnight)`);
})();

// ── 6. SERVER LISTEN — very bottom of file ───────────────────────────────
const PORT = parseInt(process.env.PORT || '3000', 10);
server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🚗 Ride-Hailing Server running on port ${PORT}`);
  console.log(`   Customer App : /customer`);
  console.log(`   Driver App   : /driver`);
  console.log(`   DB Status    : Connecting…\n`);
});
