---
name: Socket.io API routing
description: Routing rule for realtime connections on the path-mounted API server.
---

Socket.io must use `/api/socket.io` as its transport path because the API service is mounted behind the `/api` path proxy; the default `/socket.io` path will not reach the service correctly.

**Why:** The reverse proxy matches services by path without rewriting it, so the websocket handshake must include the service prefix.

**How to apply:** Configure the Socket.io server and every client with the same `/api/socket.io` path and authenticate the handshake with the existing JWT.