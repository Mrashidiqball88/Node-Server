---
name: MongoDB URI credentials
description: Compatibility rule for MongoDB connection strings whose credentials contain URI-reserved characters.
---

MongoDB credentials may arrive in `MONGO_URI` with raw reserved characters, even though standard connection-string syntax expects them to be percent-encoded. Normalize only the credential portion before constructing the MongoDB client, while preserving already-encoded sequences and the rest of the URI.

**Why:** MongoDB rejects raw credential characters such as `/` before it attempts authentication, which can make an otherwise valid secret look like a database connectivity failure.

**How to apply:** Keep the normalization local to MongoDB client construction, never log the resulting URI, and continue surfacing authentication failures distinctly from URI parsing failures.