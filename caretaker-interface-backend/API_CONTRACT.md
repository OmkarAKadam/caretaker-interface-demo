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
| GET    | `/api/events`         | Retrieve all stored events                     |
| POST   | `/api/events`         | **Create a new hardware/alert event**          |
| PATCH  | `/api/events/:alertId`| Update the status of one event (caretaker-only)|
| GET    | `/api/location`       | Retrieve the latest phone GPS location         |
| POST   | `/api/location`       | Publish the phone's current GPS location       |

---

## Phone GPS endpoints

The **user's mobile phone is the authoritative GPS source**. The phone publishes its
current coordinates, and the backend stores them as the *latest location* used to enrich
incoming hardware events that omit coordinates. This requires no GPS hardware on the ESP32.

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
| `trigger`   | string          | yes      | One of `SOS`, `HEART_RATE`, `SOS_AND_HEART_RATE`, `NORMAL`. |
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
6. **No backend authentication is required in this stage.** Not yet implemented.

---

## Ultrasonic sensor status (API-contract gap)

The hardware includes forward and downward ultrasonic sensors intended for
obstacle / ground-hazard detection.

The current backend/frontend contract does **not** define an ultrasonic trigger, and this
document does **not** invent one (no `OBSTACLE`, `CURB`, `STEP`, `ULTRASONIC` trigger).
If the ultrasonic sensors must surface as events, the project contract needs to decide
before hardware integration whether to:

- map them to a new `trigger` value (would require backend validation + frontend display updates), or
- keep them internal to future navigation logic and not report them as alert events.

This is an **open API-contract gap** to resolve before the ESP32 teammate writes ultrasonic-raising code.
