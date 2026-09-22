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
| GET    | `/api/events`         | Retrieve stored events (public, bounded to `EVENTS_WINDOW_MAX`); `?blindUserId=` scoping for caretakers |
| POST   | `/api/events`         | Create a new event (**device auth**)      |
| PATCH  | `/api/events/:alertId`| Update one event's status (**device or caretaker auth**) |
| GET    | `/api/location`       | Retrieve the latest phone GPS location (public); `?blindUserId=` scoping for caretakers |
| POST   | `/api/location`       | Publish the phone's current GPS location (**device auth**) |
| GET    | `/api/events/stream`  | SSE live feed (public)                    |
| GET    | `/api/devices`        | List monitor-cap devices (**caretaker auth**) |
| POST   | `/api/devices`        | Register a device, returns its pairing token once (**caretaker auth**) |
| GET    | `/api/devices/:id`    | Get one device (**caretaker auth**)       |
| POST   | `/api/devices/:id/rotate` | Rotate a device's token, returns the new token once (**caretaker auth**) |

### Multi-user dashboard scoping (Stage 6)

The caretaker dashboard is multi-user: a caretaker selects one of their monitored blind
users and the console shows **only that user's** events, location/state, devices and
Wall-E conversations. This is enforced on the backend:

- `GET /api/events`, `GET /api/location` and `GET /api/walle/sessions` accept an optional
  `?blindUserId=<uuid>`. When present, the caller must hold a **CARETAKER** session cookie
  **and** an ACTIVE relationship to that blind user, otherwise they get `401`/`403`/`404`.
  The response is strictly limited to that user. Without the parameter, `GET /api/events`
  and `GET /api/location` keep their pre-existing public "latest overall" behavior.
- The **unscoped** form of `GET /api/walle/sessions` is now **caretaker-authorized only**
  (Stage 8A): it requires a valid **CARETAKER** session cookie (`401` anonymous, `403`
  non-caretaker) and returns the full listing. It is no longer public, so session
  summaries/previews are not exposed to anonymous callers.
- `POST /api/walle/chat` enforces **session ownership** (Stage 8A): a device may only
  continue a Wall-E session bound to its own device identifier and blind user, and a new
  session is always bound to the authenticated device (never to client-supplied identity).
  Any mismatch answers `404 "Session not found"` so another user's session existence or
  transcript is never leaked to a different device.
- `GET /api/walle/history/:sessionId` is now **caretaker-authorized only**: a session bound
  to a monitored blind user returns `200`; everything else (no cookie, wrong role,
  unlinked user, unbound or missing session) is `401`/`403`/`404` and never leaks
  whether a session exists.
- MQTT-created events are bound to the registered device owner at persistence time: a
  cap's SOS/radar/heart-rate event carries the device identifier, the backend resolves
  it to the device's registered blind user, and the event appears in that user's scoped
  events. An **unknown** MQTT device identifier is never attached to any user — it stays
  unbound and appears only in the unscoped view.

### Production hardening (Stage 8B)

Security hardening that does **not** change the demo experience by default but adds
production-grade controls:

- **`REQUIRE_AUTH_FOR_READS=false` by default.** When set to `true`, the endpoints that
  are normally public — `GET /api/events`, `GET /api/location`, `GET /api/events/stream`,
  `GET /api/health`, `GET /api/buzzer` — require an authenticated **CARETAKER** session
  cookie (`401` anonymous, `403` non-caretaker). Scoped reads (`?blindUserId=`) already
  required this regardless. **Effect on clients:** the caretaker dashboard works either
  way; the **Blind Client's live EventSource feed (and the phone app's public health/location
  polls) break when the switch is on**, so enabling it is a production-only decision. The
  demo console keeps the default.
- **HTTP security headers** on every response (no new dependency): `X-Content-Type-Options:
  nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and
  `Strict-Transport-Security` only when `NODE_ENV=production` or the request arrived over
  HTTPS. A **Content-Security-Policy is deferred**: the static frontend uses inline scripts
  and CDN assets (Leaflet via unpkg with SRI, Google Fonts) and would need frontend
  restructuring before a safe policy can be applied.
- **Per-device write rate limits** for `POST /api/events`, `POST /api/location`,
  `POST /api/buzzer`, keyed on the **authenticated device identity** (not the client IP),
  so one device's burst can never exhaust another's budget. Exceeding the limit returns
  `429`. Defaults (`DEVICE_EVENTS_RATE_MAX=120`, `DEVICE_LOCATION_RATE_MAX=120`,
  `DEVICE_BUZZER_RATE_MAX=60` per minute) sit well above normal paired-sensor telemetry.
  The MQTT ingestion pipeline is untouched by these REST limits.
- **SSE connection cap** — `SSE_MAX_CLIENTS` (default 30) concurrent streams per instance;
  excess connections get a clean `503` and disconnected clients are removed from the count.
- **`TRUST_PROXY`** for `req.ip`/rate limiting behind a reverse proxy. Accepted values are
  a positive integer hop count or `loopback`/`linklocal`/`uniquelocal`; arbitrary values
  are **rejected** and the backend falls back to no proxy trust. Rate limiting remains
  **in-memory and per-instance** — never globally distributed.

All of these are configured in `.env.example`.

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
  stays public in the demo default and is caretaker-gated only when `REQUIRE_AUTH_FOR_READS`
  is enabled (see "Production hardening").

**ESP32 note:** per-device MQTT credentials + broker ACLs are the *future* hardening step;
the current MQTT bridge topics and the ESP firmware (hardcoded credentials) are unchanged.
The ESP does not yet authenticate as a device.

## Storage

The live feed + event state run on an **in-memory hot path** (`Map`) so REST, SSE and MQTT
stay fast and never block on a database. When PostgreSQL is configured, the backend **also
persists** events, event statuses, the latest runtime snapshot (location, device status,
heart rate, fall, buzzer) and Wall-E conversations, and **rehydrates them at boot**. If the
database is unavailable, writes are parked in a **bounded queue** (`TELEMETRY_QUEUE_MAX`,
default 500) and retried head-of-line; `GET /api/events` serves the bounded in-memory
window instead. Without a database everything still works exactly as before, just without
persistence.

## Database

The backend uses PostgreSQL (via `DATABASE_URL`) for caretaker authentication, monitored
users, caretaker↔blind-user relationships, registered devices, **and telemetry persistence
(Stage 5)**: events, latest runtime state, and Wall-E conversations. Migrations live in
`db/migrations/`:

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
npm run test:stage5    # Stage 5 — telemetry persistence & boot rehydration
npm run test:stage6    # Stage 6 — multi-user dashboard scoping & isolation
npm run test:stage8a   # Stage 8A — application security fixes (regression)
npm run test:stage8b   # Stage 8B — production hardening (read auth, headers,
                       #   per-device rate limits, SSE cap, trust proxy)
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
| `blindguardian/sensor/radar` | Single forward-looking ultrasonic reading `{deviceId, distance, danger, timestamp}`; 2 consecutive in-range (`<= 150 cm`) same-band readings → one `OBSTACLE` event |
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

The ESP32 firmware lives in this repository at `esp/esp.ino` (servo-free: a single fixed
forward-facing HC-SR04, buzzer, MAX30102 heart-rate sensor, MQTT publishing). This backend
exposes the HTTP API that the firmware and the caretaker frontend use, and ingests the
firmware's MQTT telemetry.
