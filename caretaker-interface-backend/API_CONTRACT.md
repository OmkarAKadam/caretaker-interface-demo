# Caretaker Backend API Contract — Hardware (ESP32) Integration

This document defines the API contract that the ESP32 firmware teammate uses to report
hardware events to the caretaker backend, and how the caretaker dashboard manages them.

Base URL: `http://localhost:3000`

> This is an **API contract document**, not ESP32 `.ino` code. The ESP32 teammate writes
> the firmware; the backend simply exposes these endpoints.

---

## Endpoints

| Method | Path                  | Purpose                                        |
|--------|-----------------------|------------------------------------------------|
| GET    | `/api/health`         | Health check                                   |
| GET    | `/api/events`         | Retrieve stored events (public; most recent `EVENTS_WINDOW_MAX`, default 100) |
| POST   | `/api/events`         | **Create a new hardware/alert event (device auth)** |
| GET    | `/api/events/stream`  | **SSE stream** — live events broadcast as they are created (public) |
| PATCH  | `/api/events/:alertId`| Update the status of one event (caretaker or owning device)|
| GET    | `/api/location`       | Retrieve the latest phone GPS location         |
| POST   | `/api/location`       | Publish the phone's current GPS location (device auth) |
| GET    | `/api/devices`        | List monitor-cap devices (caretaker auth)      |
| POST   | `/api/devices`        | Register a device — pairing token returned once (caretaker auth) |
| GET    | `/api/devices/:id`    | Get one device (caretaker auth)                |
| POST   | `/api/devices/:id/rotate` | Rotate a device token (caretaker auth)     |

---

## SSE event stream

`GET /api/events/stream` is a **Server-Sent Events** (SSE) endpoint. Whenever a new event is
created via `POST /api/events`, the backend broadcasts it to every connected SSE client.

The ESP32 **does not** use SSE or MQTT — it only talks to the backend over REST. The backend
distributes events to its clients:

```
ESP32 ──REST──► Backend ──SSE──► Voice Client (phone) → TTS speech
                          └─► Caretaker Dashboard
```

### GET /api/events/stream

```http
GET /api/events/stream
```

Response headers: `Content-Type: text/event-stream`. SSE format:

```sse
event: event
data: {"trigger":"OBSTACLE_LEFT","alertId":"...","latitude":22.3072,"longitude":73.1812,"timestamp":"...","status":"ACTIVE"}
```

The `data` payload is the **full stored event object** (same shape as `POST /api/events`
returns). Disconnected clients are cleaned up automatically; clients reconnect with
`retry: 3000`.

## Phone GPS endpoints

The **user's mobile phone is the authoritative GPS source**. The phone publishes its
current coordinates, and the backend stores them as the *latest location* used to enrich
incoming hardware events that omit coordinates. This requires no GPS hardware on the ESP32.

> **Who posts location:** `POST /api/location` is intended for the **remote blind-person
> phone GPS client** (see the `blind-phone/` client in the frontend). The **caretaker
> dashboard is only a consumer** of location — it reads `GET /api/location` and events
> enriched with phone coordinates, and it **must never publish its own browser GPS** to this
> endpoint. The caretaker computer is never the source of the blind person's location.

### POST /api/location — publish phone GPS

```http
POST /api/location
```

```json
{
  "latitude": 22.3072,
  "longitude": 73.1812,
  "timestamp": "2026-09-07T15:10:00Z"
}
```

| Field       | Type    | Required | Notes                                           |
|-------------|---------|----------|-------------------------------------------------|
| `latitude`  | number  | yes      | Between `-90` and `90`.                         |
| `longitude` | number  | yes      | Between `-180` and `180`.                       |
| `timestamp` | string  | optional | ISO-8601. Defaults to server now if omitted.    |

Returns `200 OK` with the stored location. Invalid data returns `400 Bad Request`.

### GET /api/location — retrieve latest phone GPS

Returns the latest published location:

```json
{
  "latitude": 22.3072,
  "longitude": 73.1812,
  "timestamp": "2026-09-07T15:10:00Z"
}
```

If no location has been received yet:

```json
{
  "latitude": null,
  "longitude": null,
  "timestamp": null
}
```

No fake GPS coordinates are ever generated or returned.

---

## Device command channel (voice-controlled buzzer)

The backend publishes **commands to the ESP32** over MQTT on the device command topic, the
opposite direction from the status/alarm topics the ESP32 already publishes to.

| Topic                      | Direction    | Purpose                          |
|----------------------------|--------------|----------------------------------|
| `blindguardian/device/status` | ESP32 → backend | Device status (existing)      |
| `blindguardian/device/command` | backend → ESP32 | **Commands to the ESP32 (new)** |

### POST /api/buzzer — send a buzzer command

The voice client posts a command here; the backend publishes it on
`blindguardian/device/command` for the ESP32 to receive and apply.

```http
POST /api/buzzer
```

```json
{ "command": "BUZZER_OFF" }
```

| Field     | Type   | Required | Notes                                       |
|-----------|--------|----------|---------------------------------------------|
| `command` | string | yes      | `BUZZER_ON` or `BUZZER_OFF`. Anything else → `400`. |

Behavior:
- The backend publishes `{ "command": "BUZZER_ON" | "BUZZER_OFF", "issuedAt": "<ISO>" }` to
  `blindguardian/device/command`.
- If MQTT is not configured or not connected, the endpoint returns `503` and **no fake state
  is recorded** — the command is not silently "applied" in the UI.
- On a successful publish, `200` returns `{ "command": ..., "state": "ON"|"OFF", "published": true }`.

### GET /api/buzzer — read last known command state

```http
GET /api/buzzer
```

Returns `{ "state": "ON"|"OFF"|null, "commandTopic": "blindguardian/device/command", "mqtt": "<state>" }`.

> **ESP32 firmware requirement (blocked until firmware is available):** the ESP32 must
> subscribe to `blindguardian/device/command` and parse `command` values `BUZZER_ON` /
> `BUZZER_OFF`, toggling its buzzer accordingly. The current `esp.ino` in this repo is a
> standalone local-radar demo with **no WiFi/MQTT**, so the physical buzzer control path
> cannot be exercised end-to-end until a network-capable firmware subscriber is added. The
> backend and voice client are already wired to this exact topic so no rework is needed once
> the firmware lands.

---

## Event location enrichment

Because the phone is the primary GPS source, `POST /api/events` no longer **requires**
event-supplied coordinates. Behavior:

- **Event supplies valid `latitude`/`longitude`** → they are preserved exactly (never
  overwritten by the phone location).
- **Event omits coordinates** → the backend enriches the event using the latest phone
  location if one is available.
- **Event omits coordinates AND no phone location exists** → `400 Bad Request` with a
  clear `Location unavailable` error (no coordinates are invented).

The enriched coordinates are stored at event-creation time. Later phone-location changes
**do not** retroactively alter already-created events.

## POST /api/events

The ESP32 reports a hardware event by `POST`-ing JSON to this endpoint.

### Canonical event schema

```json
{
  "alertId": "ALT-ESP32-001",
  "trigger": "SOS",
  "status": "ACTIVE",
  "heartRate": null,
  "latitude": 22.3072,
  "longitude": 73.1812,
  "timestamp": "2026-09-07T15:00:00"
}
```

### Field reference

| Field       | Type            | Required | Notes                                               |
|-------------|-----------------|----------|-----------------------------------------------------|
| `alertId`   | string          | yes      | Unique non-empty id. Duplicate → `409`.            |
| `trigger`   | string          | yes      | One of `SOS`, `HEART_RATE`, `SOS_AND_HEART_RATE`, `NORMAL`, `OBSTACLE_LEFT`, `OBSTACLE_CENTER`, `OBSTACLE_RIGHT`. |
| `status`    | string          | yes      | One of `NORMAL`, `ACTIVE`, `ACKNOWLEDGED`, `RESOLVED`. Hardware events normally enter as `ACTIVE`. |
| `heartRate` | number \| null  | yes      | `null` allowed. MAX30102 is optional — do not require it. |
| `latitude`  | number          | no*      | Between `-90` and `90`. *Optional if a phone location is available (enrichment); required otherwise. |
| `longitude` | number          | no*      | Between `-180` and `180`. *Optional if a phone location is available (enrichment); required otherwise. |
| `timestamp` | string (ISO-8601) | yes   | Must be a valid date/time string.                  |

### Supported `trigger` values

#### SOS — physical SOS button pressed

```json
{
  "alertId": "ALT-ESP32-SOS-001",
  "trigger": "SOS",
  "status": "ACTIVE",
  "heartRate": null,
  "latitude": 22.3072,
  "longitude": 73.1812,
  "timestamp": "2026-09-07T15:00:00"
}
```

#### HEART_RATE — only when MAX30102 is present and has a valid reading

```json
{
  "alertId": "ALT-ESP32-HR-001",
  "trigger": "HEART_RATE",
  "status": "ACTIVE",
  "heartRate": 120,
  "latitude": 22.3072,
  "longitude": 73.1812,
  "timestamp": "2026-09-07T15:01:00"
}
```

#### SOS_AND_HEART_RATE — SOS while a valid HR reading is available

```json
{
  "alertId": "ALT-ESP32-COMB-001",
  "trigger": "SOS_AND_HEART_RATE",
  "status": "ACTIVE",
  "heartRate": 130,
  "latitude": 22.3072,
  "longitude": 73.1812,
  "timestamp": "2026-09-07T15:02:00"
}
```

#### NORMAL — normal / non-emergency event (only if hardware integration needs it)

```json
{
  "alertId": "ALT-ESP32-NORMAL-001",
  "trigger": "NORMAL",
  "status": "NORMAL",
  "heartRate": null,
  "latitude": 22.3072,
  "longitude": 73.1812,
  "timestamp": "2026-09-07T15:03:00"
}
```

#### OBSTACLE_LEFT / OBSTACLE_CENTER / OBSTACLE_RIGHT — ultrasonic obstacle detection

The **mobile voice client** listens for these on the SSE stream and speaks them aloud:

| Trigger            | Spoken text              |
|--------------------|--------------------------|
| `OBSTACLE_LEFT`    | "Obstacle on your left"  |
| `OBSTACLE_CENTER`  | "Obstacle ahead"         |
| `OBSTACLE_RIGHT`   | "Obstacle on your right" |

```json
{
  "alertId": "ALT-ESP32-OBST-001",
  "trigger": "OBSTACLE_LEFT",
  "status": "ACTIVE",
  "heartRate": null,
  "latitude": 22.3072,
  "longitude": 73.1812,
  "timestamp": "2026-09-07T15:04:00"
}
```

The event flows through the same pipeline as any other trigger:
`POST /api/events` → backend → SSE → voice client → TTS speech.

### Response codes

| Code | Meaning                                                      |
|------|--------------------------------------------------------------|
| `201 Created`  | Event accepted and stored.                                 |
| `400 Bad Request` | Malformed payload (invalid trigger/status/coordinates/timestamp/alertId). Also returned when an event omits coordinates and no phone location exists (`Location unavailable`). |
| `409 Conflict` | `alertId` already exists. Event is not overwritten.         |

---

## PATCH /api/events/:alertId

Caretaker acknowledgement/resolution is **backend-controlled**. The ESP32 should **not**
perform acknowledgement or resolution — it only creates events.
### Acknowledge

```http
PATCH /api/events/ALT-ESP32-001
```

```json
{
  "status": "ACKNOWLEDGED"
}
```

### Resolve

```http
PATCH /api/events/ALT-ESP32-001
```

```json
{
  "status": "RESOLVED"
}
```

### Response codes

| Code | Meaning                                  |
|------|------------------------------------------|
| `200 OK`   | Status updated; returns full event.     |
| `400 Bad Request` | Missing/invalid `status`.           |
| `404 Not Found`   | No event with that `alertId`.       |
| `409 Conflict`    | Invalid status transition.           |

### Allowed status transitions

```
ACTIVE
  ├── ACKNOWLEDGED
  └── RESOLVED
ACKNOWLEDGED
  └── RESOLVED
```

Rejected (return `409`): `RESOLVED → ACTIVE`, `RESOLVED → ACKNOWLEDGED`,
`ACKNOWLEDGED → ACTIVE`, and any transition that turns a `NORMAL` event into an active alert.

---

## Conceptual ESP32 integration flow

```
SOS button pressed
        ↓
Create unique alertId (e.g. ALT-ESP32-<counter>)
        ↓
Read latest available HR if the MAX30102 exists
        ↓
Use current/latest location supplied by the system architecture
        ↓
POST /api/events
```

Example JSON the ESP32 would send for a plain SOS press:

```json
{
  "alertId": "ALT-ESP32-001",
  "trigger": "SOS",
  "status": "ACTIVE",
  "heartRate": null,
  "latitude": 22.3072,
  "longitude": 73.1812,
  "timestamp": "2026-09-07T15:00:00"
}
```

---

## Important architecture notes for the ESP32 teammate

1. **GPS is NOT a hard requirement from the ESP32.** The **user's mobile phone is the
   primary GPS source** (see the Phone GPS endpoints above). The `latitude`/`longitude`
   fields are preserved for event-contract compatibility, and the backend now **enriches**
   events that omit coordinates using the latest phone location. The ESP32 should not be
   built around providing GPS.
2. **MAX30102 is optional.** If the sensor is absent, send `heartRate: null`. `SOS` must
   always work independently of heart rate. Never fabricate a HR value.
3. **Every new alert needs a unique `alertId`.** Reusing one returns `409` and the original
   event is preserved. Use a monotonically increasing counter, e.g.
   `ALT-ESP32-001`, `ALT-ESP32-002`, `ALT-ESP32-003`.
4. **Hardware events normally enter as `ACTIVE`.** Acknowledge/Resolve is done by the
   caretaker via `PATCH /api/events/:alertId` — not by the ESP32.
5. **Event type is encoded in `trigger`, not in the URL.** There are no separate
   `/api/sos`, `/api/heartbeat`, `/api/ultrasonic`, `/api/esp32` endpoints. Use `POST /api/events`.
6. **The blind client (phone) authenticates as a device; the ESP32 does not yet.**
   `POST /api/events`, `POST /api/location`, `PATCH /api/events/:alertId`,
   `POST /api/buzzer` and `POST /api/walle/chat` now require the `X-Device-Id` /
   `X-Device-Token` headers (see *Device authentication* below). The ESP32 firmware and the
   MQTT bridge are unchanged this stage; per-device MQTT credentials/ACLs are future
   hardening.

---

## Device authentication & registration (Stage 4)

Devices (the cap + the blind person's phone) are registered and rotated **exclusively by
the caretaker**, so there is no self-signup or public creation endpoint.

### Register a device (caretaker session required)

```http
POST /api/devices
Cookie: bg_session=<session token>
Content-Type: application/json
```

```json
{
  "blindUserId": "uuid-of-the-monitored-user",
  "deviceIdentifier": "BG001",
  "friendlyName": "Assistive Cap"
}
```

`deviceIdentifier` must match `^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$`. The blind user must
have an ACTIVE relationship with the caretaker, otherwise `404`.

- `201 Created` → `{ "device": {…}, "token": "…" }` — the plaintext token appears
  **exactly once** and is not retrievable afterwards.

```json
{
  "device": {
    "id": "uuid",
    "blindUserId": "uuid-of-the-monitored-user",
    "deviceIdentifier": "BG001",
    "friendlyName": "Assistive Cap",
    "status": "OFFLINE",
    "lastSeenAt": null
  },
  "token": "JNaSv6X0VpB2kvfhzZb2g3S-UQ4W2ZL5yP_d0vM1sQQ"
}
```

- `409` if the identifier is already registered. `401` without a caretaker session.
- `404` if the caretaker is not linked to `blindUserId`.

### Rotate a device token (caretaker session required)

```http
POST /api/devices/:id/rotate
```

Returns `{ "device": {…}, "token": "<new-token>" }`. The previous token is revoked
immediately. The new token is also returned exactly once.

### List devices (caretaker session required)

| Method | Path | Notes |
|--------|------|-------|
| GET | `/api/devices` | All devices the caretaker can see (linked blind users). |
| GET | `/api/devices?blindUserId=<uuid>` | Filter; `404` if not linked. |
| GET | `/api/devices/:id` | Single device; `404` if not the caretaker's. |

Every device listing returns the **safe** shape only — `secret_hash` and the token are
never exposed.

### Authenticated device calls (phone → backend)

```http
X-Device-Id: <deviceIdentifier>
X-Device-Token: <43-char base64url token>
```

- `401` (generic, identical body) for missing/malformed/wrong/unknown credentials.
- Identity is server-derived: the request body may never override `deviceId` or
  `blindUserId`.
- Event `PATCH` requires the event to belong to the authenticated device
  (`403` otherwise). Caretakers can still update any linked user's events.
- The SSE feed `/api/events/stream`, `GET /api/location`, `GET /api/events` and
  `GET /api/health` remain public (caretaker console + voice client).

---

## Ultrasonic sensor status (API-contract resolved)

The hardware includes forward and downward ultrasonic sensors intended for
obstacle / ground-hazard detection.

**This contract now defines obstacle triggers** — the mobile voice client speaks them:

- `OBSTACLE_LEFT` → "Obstacle on your left"
- `OBSTACLE_CENTER` → "Obstacle ahead"
- `OBSTACLE_RIGHT` → "Obstacle on your right"

Obstacle events are normal alert events: the ESP32 `POST`s them to `/api/events`, the backend
broadcasts them over the SSE stream, and the voice client (phone) turns them into spoken
alerts. Ground-hazard events (curb / step detection) are **not yet defined**; if they must
surface as events, add triggers to the validator and document them here.

---

## Wall-E AI chat endpoint

The mobile voice client sends user speech to the backend for AI-powered conversational
responses. The AI runs server-side via NVIDIA NIM; **no API key is exposed to the browser**.

| Method | Path              | Purpose                          |
|--------|-------------------|----------------------------------|
| POST   | `/api/walle/chat` | Send a user message, get an AI reply |

### POST /api/walle/chat

```http
POST /api/walle/chat
Content-Type: application/json

{
  "sessionId": "blind-session-001",
  "message": "What can you help me with?"
}
```

| Field       | Type   | Required | Notes                                                        |
|-------------|--------|----------|--------------------------------------------------------------|
| `sessionId` | string | yes      | Identifies the conversation session. Non-empty.              |
| `message`   | string | yes      | User's spoken message. Non-empty. Max 1000 characters (configurable via `WALLE_MAX_MESSAGE_LENGTH`). |

#### Response — `200 OK`

```json
{
  "sessionId": "blind-session-001",
  "reply": "I can help with directions, answer questions, and give weather updates. Just ask.",
  "timestamp": "2026-09-10T12:00:00.000Z",
  "model": "nvidia/nemotron-3.5-lightning-30b-a3b"
}
```

| Field       | Type   | Description                                          |
|-------------|--------|------------------------------------------------------|
| `sessionId` | string | Echoed back from the request.                        |
| `reply`     | string | AI-generated response, optimised for text-to-speech. |
| `timestamp` | string | ISO-8601 timestamp of when the response was generated.|
| `model`     | string | The model that produced the response.                |

#### Error responses

| Code | Meaning                  | Body example                                                |
|------|--------------------------|-------------------------------------------------------------|
| 400  | Missing/empty `sessionId` or `message`, or message too long | `{ "error": "message is required" }` |
| 503  | All AI models failed     | `{ "error": "AI_PROVIDER_UNAVAILABLE", "message": "AI service temporarily unavailable" }` |
| 500  | Unexpected server error  | `{ "error": "Internal server error" }`                      |

### Wall-E conversation history (read-only, caretaker view)

Conversation history is exposed read-only for future caretaker UI use. Sessions live on the
**in-memory hot path** and are **mirrored to PostgreSQL in the background** when the
database is configured, so they survive a backend restart (boot rehydration); without a
database they remain in-memory only. The in-memory retention limits still apply
(`WALLE_SESSION_TTL_MS` default 24h, `WALLE_MAX_SESSIONS` default 100, and per-session
`WALLE_SESSION_MAX_TURNS` default 20).

| Method | Path                          | Purpose                                    |
|--------|-------------------------------|--------------------------------------------|
| GET    | `/api/walle/sessions`         | List retained Wall-E conversation sessions |
| GET    | `/api/walle/history/:sessionId` | Retrieve the transcript for one session  |

#### GET /api/walle/sessions

Returns a JSON array of session summaries, newest/most-recently-active first. Sensor or
trusted-context data is **never** included.

```http
GET /api/walle/sessions
```

Response — `200 OK`:

```json
[
  {
    "sessionId": "blind-session-001",
    "startedAt": "2026-09-10T11:58:00.000Z",
    "lastActiveAt": "2026-09-10T12:02:00.000Z",
    "turnCount": 4,
    "preview": "Am I near the bus stop?"
  }
]
```

| Field          | Type   | Description                                                    |
|----------------|--------|----------------------------------------------------------------|
| `sessionId`    | string | Identifier of the conversation session.                        |
| `startedAt`    | string | ISO-8601 time the session was created.                         |
| `lastActiveAt` | string | ISO-8601 time of the most recent turn.                         |
| `turnCount`    | number | Number of retained turns in the session.                       |
| `preview`      | string | Short preview of the conversation (most recent user message, truncated to 100 chars). |

#### GET /api/walle/history/:sessionId

Returns the retained transcript for one session. The session must exist and be within its
TTL; otherwise `404`. Requesting history **never creates** a session.

```http
GET /api/walle/history/blind-session-001
```

#### Response — `200 OK`

```json
{
  "sessionId": "blind-session-001",
  "startedAt": "2026-09-10T11:58:00.000Z",
  "lastActiveAt": "2026-09-10T12:02:00.000Z",
  "turns": [
    { "role": "user", "text": "Am I near the bus stop?", "timestamp": "2026-09-10T11:58:00.000Z" },
    { "role": "assistant", "text": "Yes, about 40m ahead on the right.", "timestamp": "2026-09-10T11:58:05.000Z", "model": "nvidia/nemotron-3.5-lightning-30b-a3b" }
  ]
}
```

| Field          | Type                              | Description                                                    |
|----------------|-----------------------------------|----------------------------------------------------------------|
| `sessionId`    | string                            | Identifier of the conversation session.                        |
| `startedAt`    | string                            | ISO-8601 time the session was created.                         |
| `lastActiveAt` | string                            | ISO-8601 time of the most recent turn.                         |
| `turns`        | array of turn objects             | Retained turns in chronological order.                         |
| `turns[].role` | `"user"` \| `"assistant"`         | Speaker of the turn.                                           |
| `turns[].text` | string                            | Turn text.                                                     |
| `turns[].timestamp` | string                       | ISO-8601 time of the turn.                                     |
| `turns[].model` | string (assistant only)          | Model that produced the reply; absent when unknown.            |

#### Error responses

| Code | Meaning                                                    | Body example                       |
|------|------------------------------------------------------------|------------------------------------|
| 404  | Session does not exist, is expired, or is not retained     | `{ "error": "Session not found" }` |

#### Architecture

```
Blind Client (browser)
      │  POST /api/walle/chat
      ▼
   Backend  ──►  system prompt + user message
      │
      ▼
   NVIDIA NIM (primary → fallback 1 → fallback 2)
      │
      ▼
   { sessionId, reply, timestamp, model }  ──►  TTS via Web Speech API
```

The backend owns the system prompt and trusted context (future step). The browser never
holds an AI API key. The `sessionId` is for future per-session conversation history and
caretaker-viewable conversation logs.
