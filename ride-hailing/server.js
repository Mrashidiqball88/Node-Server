/**
 * Ride-Hailing App — Express + Mongoose + Socket.io
 * Serves Customer App (/customer) and Driver App (/driver)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const express = require('express');
const mongoose = require('mongoose');
const bcrypt   = require('bcryptjs');
const jwt      = require('jsonwebtoken');
const cors     = require('cors');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*', methods: ['GET', 'POST'] } });

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
  email:   { type: String, required: true, unique: true, lowercase: true, trim: true },
  password:{ type: String, required: true },
  phone:   { type: String, default: '' },
  role:    { type: String, enum: ['customer', 'driver'], default: 'customer' },
  vehicleType: { type: String, enum: ['Bike', 'Rickshaw', 'Car Mini', 'Car AC', ''], default: '' },
  isOnline: { type: Boolean, default: false },
  isAdmin:  { type: Boolean, default: false },
  currentLocation: {
    lat: { type: Number, default: 0 },
    lng: { type: Number, default: 0 }
  },
  rating:     { type: Number, default: 5.0 },
  totalRides: { type: Number, default: 0 }
}, { timestamps: true });

const rideSchema = new mongoose.Schema({
  passenger: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driver:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  pickupLocation: {
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, default: 'Pickup Point' }
  },
  dropoffLocation: {
    lat:     { type: Number, required: true },
    lng:     { type: Number, required: true },
    address: { type: String, default: 'Dropoff Point' }
  },
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
  vehicleType: { type: String, default: 'Car Mini' },
  notes:       { type: String, default: '' }
}, { timestamps: true });

const walletSchema = new mongoose.Schema({
  user:    { type: mongoose.Schema.Types.ObjectId, ref: 'User', unique: true },
  balance: { type: Number, default: 0 },
  transactions: [{
    amount:      Number,
    type:        { type: String, enum: ['credit', 'debit'] },
    description: String,
    createdAt:   { type: Date, default: Date.now }
  }]
}, { timestamps: true });

const sosSchema = new mongoose.Schema({
  user:     { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  location: { lat: Number, lng: Number },
  message:  { type: String, default: 'SOS Emergency Alert!' },
  ride:     { type: mongoose.Schema.Types.ObjectId, ref: 'Ride', default: null },
  resolved: { type: Boolean, default: false }
}, { timestamps: true });

const paymentSchema = new mongoose.Schema({
  driver:          { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  trxId:           { type: String, required: true, trim: true },
  amount:          { type: Number, required: true },
  vehicleCategory: { type: String, required: true },
  status:          { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending' },
  adminNote:       { type: String, default: '' },
  submittedDate:   { type: String, required: true }   // 'YYYY-MM-DD' UTC date, for uniqueness check
}, { timestamps: true });

// One TRX submission per driver per calendar day
paymentSchema.index({ driver: 1, submittedDate: 1 }, { unique: true });

const User    = mongoose.model('User',    userSchema);
const Ride    = mongoose.model('Ride',    rideSchema);
const Wallet  = mongoose.model('Wallet',  walletSchema);
const SOS     = mongoose.model('SOS',     sosSchema);
const Payment = mongoose.model('Payment', paymentSchema);

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
// Admin Middleware
// ─────────────────────────────────────────────────────────────────────────────

async function adminMiddleware(req, res, next) {
  // authMiddleware must run first to populate req.user
  try {
    const user = await User.findById(req.user.id).select('isAdmin');
    if (!user || !user.isAdmin) {
      return res.status(403).json({ error: 'Admin access required' });
    }
    next();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auth Routes
// ─────────────────────────────────────────────────────────────────────────────

app.post('/api/auth/register', async (req, res) => {
  try {
    const { name, email, password, phone, role, vehicleType } = req.body;
    if (!name || !email || !password) {
      return res.status(400).json({ error: 'Name, email and password are required' });
    }
    if (await User.findOne({ email })) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const hash = await bcrypt.hash(password, 12);
    const user = await User.create({
      name, email, password: hash,
      phone:       phone       || '',
      role:        role        || 'customer',
      vehicleType: vehicleType || ''
    });
    await Wallet.create({ user: user._id, balance: 0, transactions: [] });

    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.status(201).json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, vehicleType: user.vehicleType }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });
    const user = await User.findOne({ email });
    if (!user || !(await bcrypt.compare(password, user.password))) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = jwt.sign(
      { id: user._id, email: user.email, role: user.role, name: user.name },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({
      token,
      user: { id: user._id, name: user.name, email: user.email, role: user.role, vehicleType: user.vehicleType }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
    const { pickupLocation, dropoffLocation, fare, distance, vehicleType, notes } = req.body;
    if (!pickupLocation || !dropoffLocation || !fare) {
      return res.status(400).json({ error: 'Pickup, dropoff and fare are required' });
    }
    const ride = await Ride.create({
      passenger: req.user.id,
      pickupLocation, dropoffLocation, fare,
      distance:    distance    || 0,
      vehicleType: vehicleType || 'Car Mini',
      notes:       notes       || ''
    });

    // Broadcast to all online drivers
    io.to('drivers-online').emit('ride:new', {
      id:              ride._id,
      pickupLocation:  ride.pickupLocation,
      dropoffLocation: ride.dropoffLocation,
      fare:            ride.fare,
      distance:        ride.distance,
      vehicleType:     ride.vehicleType,
      notes:           ride.notes,
      createdAt:       ride.createdAt
    });

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

    io.to(`ride:${ride._id}`).emit('ride:accepted', {
      rideId:  ride._id,
      driver:  { id: req.user.id, name: req.user.name }
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
    const wallet = await Wallet.findOneAndUpdate(
      { user: req.user.id },
      { $inc: { balance: amount },
        $push: { transactions: { amount, type: 'credit', description: 'Wallet top-up' } } },
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
    const { trxId, amount } = req.body;
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

    const payment = await Payment.create({
      driver:          req.user.id,
      trxId:           trxId.trim(),
      amount:          Number(amount),
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
    const { location, message, rideId } = req.body;
    const sos = await SOS.create({
      user:     req.user.id,
      location: location || { lat: 0, lng: 0 },
      message:  message  || 'SOS Emergency Alert!',
      ride:     rideId   || null
    });
    io.emit('sos:alert', {
      userId:   req.user.id,
      userName: req.user.name,
      location, message, rideId,
      ts: new Date().toISOString()
    });
    res.status(201).json({ success: true, sos });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', db: dbConnected ? 'connected' : 'testing-mode', ts: new Date().toISOString() });
});

// Page routes — '/' opens the customer app directly
app.get('/customer', (_req, res) => res.sendFile(path.join(__dirname, 'public', 'customer.html')));
app.get('/driver',   (_req, res) => res.sendFile(path.join(__dirname, 'public', 'driver.html')));
app.get('/admin',    (_req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/',         (_req, res) => res.sendFile(path.join(__dirname, 'public', 'customer.html')));

// Catch-all: serve customer app for any unmatched GET (prevents Cloud Run 404 on deep links)
app.use((_req, res) => res.sendFile(path.join(__dirname, 'public', 'customer.html')));

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
  const { id, name, role } = socket.user;
  console.log(`Socket connected: ${name} [${role}]`);

  if (role === 'driver') socket.join('drivers-online');

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

const PORT = parseInt(process.env.PORT || '3000', 10);

async function start() {
  const rawUri = process.env.MONGO_URI;
  if (!rawUri) {
    console.warn('⚠  MONGO_URI not set — running in testing mode (data not persisted)');
  } else {
    const uri = normalizeMongoUri(rawUri);
    try {
      await mongoose.connect(uri, { serverSelectionTimeoutMS: 8000 });
      dbConnected = true;
      console.log('✓ MongoDB Atlas connected');
    } catch (err) {
      console.warn('⚠  MongoDB unavailable, running in testing mode:', err.message);
    }
  }

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚗 Ride-Hailing Server running on port ${PORT}`);
    console.log(`   Customer App : /customer`);
    console.log(`   Driver App   : /driver`);
    console.log(`   DB Status    : ${dbConnected ? 'Connected' : 'Testing Mode'}\n`);
  });
}

start();
