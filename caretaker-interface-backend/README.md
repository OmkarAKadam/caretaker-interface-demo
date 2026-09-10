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
| GET    | `/api/health`         | Health check                              |
| GET    | `/api/events`         | Retrieve all stored events                |
| POST   | `/api/events`         | Create a new hardware/alert event         |
| PATCH  | `/api/events/:alertId`| Update one event's status                 |
| GET    | `/api/location`       | Retrieve the latest phone GPS location    |
| POST   | `/api/location`       | Publish the phone's current GPS location  |

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

## Storage

This backend uses **in-memory storage** (`Map`). There is no database. **All events and
the latest location are lost when the server restarts.**

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
