# Smart Assistive Cap — Caretaker Backend

Backend API for the Smart Assistive Cap for Visually Impaired Navigation & Emergency Alert caretaker console.

## Requirements

- Node.js

## Installation

```text
npm install
```

## Run

```text
npm start
```

To load environment variables from a `.env` file (Node 20.6+):

```text
npm run start:env
```

## Default URL

```text
http://localhost:3000
```

The port is configurable via the `PORT` environment variable (defaults to `3000`).

## API endpoints

| Method | Path                  | Purpose                                   |
|--------|-----------------------|-------------------------------------------|
| GET    | `/api/health`         | Health check (public)                     |
| GET    | `/api/events`         | Retrieve all stored events (public)       |
| POST   | `/api/events`         | Create a new event (**device auth**)      |
| PATCH  | `/api/events/:alertId`| Update one event's status (**device or caretaker auth**) |
| GET    | `/api/location`       | Retrieve the latest phone GPS location (public) |
| POST   | `/api/location`       | Publish the phone's current GPS location (**device auth**) |
| GET    | `/api/events/stream`  | SSE live feed (public)                    |
| GET    | `/api/devices`        | List monitor-cap devices (**caretaker auth**) |
| POST   | `/api/devices`        | Register a device, returns its pairing token once (**caretaker auth**) |
| GET    | `/api/devices/:id`    | Get one device (**caretaker auth**)       |
| POST   | `/api/devices/:id/rotate` | Rotate a device's token, returns the new token once (**caretaker auth**) |

See `API_CONTRACT.md` for the full request/response contract.

## Architecture

```
Phone GPS  ──POST /api/location──▶ Backend (latest location)
ESP32 event ──POST /api/events──▶ Backend (location enrichment)
Backend ──GET /api/events, PATCH /api/events/:alertId──▶ Caretaker frontend
```

The **phone is the primary GPS source**. The ESP32 does not require GPS. Incoming
events that omit coordinates are enriched with the latest phone location.

## Heart rate (MAX30102)

Heart rate is **optional**. The MAX30102 sensor may be absent, in which case events send
`heartRate: null`. `SOS` must always work without a heart-rate reading, and the backend
never generates or infers a heart-rate value.

## Device authentication (Stage 4 — blind-client pairing)

The blind person's phone authenticates as a **device** on the blind-client REST
endpoints. Devices are **registered and rotated by the caretaker** in the console.

### How pairing works

1. The caretaker registers a device identifier (e.g. `BG001`) for a monitored user via
   `POST /api/devices` in the console or API.
2. The backend generates a **43-character, base64url, 32-byte random token**, stores only
   its **bcrypt hash** (`devices.secret_hash`), and returns the plaintext token **exactly
   once** in the creation response.
3. The caretaker enters that identifier + token into the blind person's phone
   (Pair Device screen). The phone stores them locally and sends them on every call.
4. The token can be **rotated** at any time (`POST /api/devices/:id/rotate`) — the old
   token stops working immediately and the new one is returned once.

### Wire protocol

The phone sends two headers on protected calls:

```text
X-Device-Id:   BG001
X-Device-Token: <43-char base64url token>
```

Protected endpoints (require a valid device): `POST /api/location`, `POST /api/events`,
`PATCH /api/events/:alertId`, `POST /api/buzzer`, `POST /api/walle/chat`.

Security rules implemented:

- Missing, malformed, unknown, or wrong credentials all return the **same generic 401**
  (no oracle to guess valid device identifiers or tokens).
- The client-supplied `deviceId` / `blindUserId` is **never trusted**: events, locations
  and Wall-E sessions are bound to the authenticated device and its linked blind user.
- A device **cannot modify** another device's event (`PATCH` → 403).
- The plaintext token is never returned by any `GET`, never logged, never sent in a URL.
- Device `last_seen_at` is throttled via `DEVICE_TOUCH_THROTTLE_MS` (default 5 min).
- Device identity is a **Blind Client concern**; the live SSE feed (`/api/events/stream`)
  stays public this stage for the caretaker console.

**ESP32 note:** per-device MQTT credentials + broker ACLs are the *future* hardening step;
the current MQTT bridge topics and the ESP firmware (hardcoded credentials) are unchanged.
The ESP does not yet authenticate as a device.

## Storage

This backend uses **in-memory storage** (`Map`). There is no database. **All events and
the latest location are lost when the server restarts.**

## Database

The backend uses PostgreSQL (via `DATABASE_URL`) for caretaker authentication, monitored
users, caretaker↔blind-user relationships, and registered devices. The live event feed and
latest location remain in-memory (lost on restart). Migrations live in `db/migrations/`:

```text
npm run migrate          # apply pending migrations
npm run migrate:status   # show applied migrations
```

## Testing

Ephemeral end-to-end test harnesses spin up the real server + real local database, then
clean up after themselves:

```text
npm run test:auth      # Stage 2 — caretaker accounts & sessions
npm run test:stage3    # Stage 3 — monitored users & caretaker authorization
npm run test:stage4    # Stage 4 — device pairing & blind-client authentication
```

## MQTT (optional)

The backend can connect to **HiveMQ Cloud** as an additional input channel via a
server-side MQTT client (`mqtt/`). MQTT is **optional**: if it is not configured or the
broker is unreachable, the REST API still runs normally. MQTT does not replace REST, SSE,
or the existing event processing.

Configure via environment variables (see `.env.example`):

| Variable         | Purpose                                                              |
|------------------|----------------------------------------------------------------------|
| `MQTT_BROKER_URL`| Broker URL, e.g. `mqtts://<cluster>.s2.eu.hivemq.cloud:8883` (TLS). |
| `MQTT_USERNAME`  | HiveMQ Cloud username.                                               |
| `MQTT_PASSWORD`  | HiveMQ Cloud password.                                               |
| `MQTT_CLIENT_ID` | Optional — auto-generated as `caretaker-backend-<random>` if empty.  |

The client subscribes to the project MQTT topics defined in `mqtt/topics.js` and routes
messages into the **existing backend processing flow** (no separate alert system):

| Topic | Behavior |
|-------|----------|
| `blindguardian/sensor/radar` | `direction` `LEFT`/`CENTER`/`RIGHT` → `OBSTACLE_LEFT`/`OBSTACLE_CENTER`/`OBSTACLE_RIGHT` event |
| `blindguardian/emergency/sos` | → `SOS` event |
| `blindguardian/mobile/location` | Updates the same latest location used by `POST /api/location` |
| `blindguardian/device/status` | Tracks latest device status in memory (exposed as `deviceStatus` on `/api/health`) |
| `blindguardian/mobile/fall` | Stored in memory + logged only (no `FALL` trigger in the event model yet) |
| `blindguardian/alerts` | Routed through the existing event flow only if the payload carries a valid existing `trigger`; otherwise logged |
| `blindguardian/sensor/distance` | Subscribed, handled safely, logged only |

Per-device MQTT credentials and broker ACLs (one identity per cap) are a **future
hardening** item; stage 4 does not change the MQTT bridge or the ESP firmware.

MQTT-created events reuse the same `events` store and SSE broadcast as `POST /api/events`,
so existing SSE clients receive them on the same `/api/events/stream`. Malformed or invalid
MQTT payloads are logged and ignored without crashing or affecting REST.

`GET /api/health` reports an informational `mqtt` field
(`disabled`/`connecting`/`connected`/`reconnecting`/`disconnected`/`error`) and an optional
`deviceStatus` object, without affecting the `status: ok` health result.

## Hardware note

The ESP32 firmware (`smooth-assist.ino`) is managed separately and is **not** included in
this repository. This backend only exposes the HTTP API that the firmware and the caretaker
frontend use.
