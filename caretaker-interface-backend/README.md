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

## Hardware note

The ESP32 firmware (`smooth-assist.ino`) is managed separately and is **not** included in
this repository. This backend only exposes the HTTP API that the firmware and the caretaker
frontend use.
