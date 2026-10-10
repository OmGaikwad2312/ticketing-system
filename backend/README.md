# Bastion Ticketing Backend

Bastion is a seat-reservation backend built with Node.js, Express, Redis, BullMQ, and PostgreSQL. Redis makes the immediate hold and sale decisions; PostgreSQL stores durable booking rows asynchronously. The design is intended to protect seat integrity under concurrent requests, not to promise unlimited capacity or a fixed throughput.

## Architecture

```text
Clients
   │
   ├── API :3001 ─┐
   ├── API :3002 ─┼── Redis 7 ── BullMQ persistence queue ── workers ── PostgreSQL 16
   └── API :3003 ─┘      │                                  │
                          ├── seat-state Pub/Sub ── Socket.IO
                          ├── sweeper: recover missing persistence jobs
                          └── reconciler: inspect stale payment sessions
```

`npm run start:all` runs three identical API processes, two persistence workers, one sweeper, and one payment reconciler. The APIs are stateless with respect to booking decisions; each process uses the same Redis event state. The local process supervisor restarts crashed children and stops them together when interrupted. It is a development runner, not a production process manager or load balancer.

### Booking and persistence flow

1. **Hold:** `POST /hold` (or the first step of `POST /book`) calls a Redis Lua script. The script checks that the seat is neither sold nor held and creates a TTL-backed hold atomically. Redis key expiry frees an abandoned hold.
2. **Checkout/payment:** The demo payment flow creates a Redis payment session. A Redis lock prevents concurrent retries from invoking the mock gateway more than once for the same booking ID. This is a mock gateway; no real card is charged.
3. **Confirm:** A Redis Lua script verifies the hold and atomically records the sale in the event's sold-seat hash and creates a booking handoff record. Only after that does the API enqueue a BullMQ persistence job.
4. **Persist:** Workers insert the booking into PostgreSQL idempotently. PostgreSQL also has a unique constraint on `(event_id, unit_id)` as a final duplicate-seat guard.
5. **Recover:** Failed transient jobs are retried with exponential backoff capped at 30 seconds. The sweeper scans sold bookings that are still missing in PostgreSQL after the grace period and re-enqueues missing jobs or retries failed jobs. Permanent seat conflicts are dead-lettered; exhausting transient retries alone does not create a dead letter.

### Concurrency, consistency, and limits

Redis executes each Lua script atomically, so competing requests cannot interleave the check-and-update for a hold or sale. This is the core protection against selling the same seat twice across API instances. A single Redis event keyspace is still a shared throughput and availability dependency; adding API processes does not make Redis unlimited.

The Redis sold hash is the immediate booking decision state. PostgreSQL is the durable booking store and is updated asynchronously, so it can temporarily lag during an outage. Startup and Redis reconnect rehydration copy PostgreSQL sales back into Redis. Redis is configured for AOF persistence with `appendfsync always` and `noeviction`, but this single-node local setup does not provide host-level replication or eliminate the risk of losing a sale that has not yet reached PostgreSQL if Redis data itself is lost.

Rate limiting uses Redis token buckets per user and per IP for booking actions. `GET /seats` uses the IP limiter. Socket.IO broadcasts best-effort seat updates through Redis Pub/Sub; live updates do not decide whether a booking succeeds.

## Requirements and setup

- Node.js 18 or later
- Docker with the Compose plugin

From this `backend` directory:

```sh
docker compose up -d
npm install
```

Configuration defaults are defined in `src/config.js`. To customize them, copy `.env.example` to `.env` (PowerShell: `Copy-Item .env.example .env`). Keep secrets out of source control. The Compose file starts Redis 7 and PostgreSQL 16 on ports 6379 and 5432; update both the Compose port mappings and connection URLs if those ports are already in use.

Start the local stack:

```sh
npm run start:all
```

The supervisor starts API ports 3001, 3002, and 3003. To run one API process or an individual service, use `npm run start:api`, `npm run start:worker`, `npm run start:sweeper`, or `npm run start:reconciler` in separate terminals. Set `PORT` for an API process and `WORKER_ID` to distinguish persistence worker logs.

## HTTP API

Requests that identify a user use `x-user-id` in the default `AUTH_MODE=header` development configuration. In `AUTH_MODE=jwt`, provide a valid HS256 bearer token and set `JWT_SECRET`. Header-based identity is for local development and load testing, not production authentication.

| Endpoint | Purpose | Typical outcomes |
|---|---|---|
| `GET /health` | Probe Redis readiness and PostgreSQL connectivity | `200` when both are healthy; `503` reports dependency state. Booking can continue during a PostgreSQL outage while Redis is ready. |
| `GET /seats` | Return the event seat map and counts from Redis | `200` with `event`, `total`, `seats`, `counts`, and `seq`. |
| `POST /hold` `{ "unit": 7 }` | Temporarily hold a seat | `200` held; `409` sold/held; `429` rate/hold limit; `503` Redis not ready. |
| `POST /release` `{ "unit": 7 }` | Release the caller's hold | `200` with `released` boolean. |
| `POST /checkout` `{ "unit": 7, "bookingId": "..." }` | Create a payment session for an existing hold | `200` pending session; `409` if the hold is unavailable. |
| `POST /pay` `{ "bookingId": "..." }` | Run/resolve payment and confirm the seat | `200` booked; `202` payment in progress; `402` payment failed; `409` sold; `410` expired; `503` not ready. |
| `POST /book` `{ "unit": 7, "bookingId": "..." }` | Convenience endpoint for hold, mock payment, and confirmation | `200` booked; conflict, payment, expiration, rate-limit, and availability responses as applicable. |

For retry-safe client requests, send the same stable `bookingId` when retrying `POST /book`. The endpoint creates an ID when one is omitted, but a client that loses the response cannot safely identify that request on its own.

### Live seat updates

Socket.IO clients can connect with WebSocket transport (`transports: ['websocket']`). A connection receives a `seatmap` snapshot followed by seat-change events relayed through Redis Pub/Sub. Events include a monotonically increasing sequence number so clients can ignore events older than their snapshot. These events are informational; use the HTTP API response as the booking decision.

## Configuration

All settings below have defaults in `src/config.js`; `.env.example` lists the same values and comments.

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3001` | Port for one API process; `start:all` assigns 3001–3003. |
| `REDIS_URL` | `redis://127.0.0.1:6379` | Redis connection. |
| `DATABASE_URL` | local `tickets` database on port `5432` | PostgreSQL connection URL; see `.env.example`. |
| `EVENT_ID` | `e1` | Event namespace for inventory and bookings. |
| `TOTAL_UNITS` | `200` | Number of seats. |
| `HOLD_TTL_MS` / `MAX_HOLD_TOTAL_MS` | `90000` / `180000` | Seat hold lifetime and maximum cumulative hold duration. |
| `MAX_HOLDS_PER_USER` | `4` | Concurrent hold limit per user. |
| `PAY_SESSION_TTL_MS` / `PAID_SESSION_TTL_MS` | `90000` / `3600000` | Payment session lifetimes. |
| `PAYMENT_DELAY_MS` / `PAYMENT_FAIL_RATE` | `100` / `0` | Mock gateway delay and failure probability. |
| `PAYMENT_TIMEOUT_MS` / `STUCK_LOCK_MS` | `15000` / `15000` | Payment hold extension and stuck-lock alert threshold. |
| `AUTH_MODE` / `JWT_SECRET` | `header` / empty | Development header identity or HS256 JWT authentication. |
| `TRUST_PROXY` | `false` | Express proxy trust setting used for client IP handling. |
| `RATE_LIMIT_ENABLED` | `true` | Enable Redis token-bucket limits. |
| `BUCKET_CAPACITY` / `BUCKET_REFILL_PER_SEC` | `20` / `10` | Per-user burst and refill rate. |
| `IP_BUCKET_CAPACITY` / `IP_BUCKET_REFILL_PER_SEC` | `15000` / `5000` | Per-IP burst and refill rate. |
| `SEATMAP_CACHE_MS` | `250` | Seat-map cache lifetime. |
| `PERSIST_QUEUE_NAME` / `BULL_PREFIX` | `persist-bookings` / event-derived | BullMQ queue and Redis prefix. |
| `WORKER_CONCURRENCY` | `10` | Jobs processed concurrently per persistence worker. |
| `JOB_ATTEMPTS` / `JOB_BACKOFF_CAP_MS` | `10` / `30000` | Persistence retry count and maximum retry delay. |
| `SWEEP_INTERVAL_MS` / `SWEEP_GRACE_MS` | `15000` / `10000` | Sweeper frequency and minimum booking age before recovery. |
| `STALLED_INTERVAL_MS` | `5000` | BullMQ stalled-job check interval. |
| `BOOKING_RECORD_TTL_MS` | `604800000` | Redis booking handoff record lifetime. |

## Recovery and operational notes

- **PostgreSQL unavailable:** Redis-backed booking decisions can still succeed. Persistence jobs retry, and the sweeper recovers missing or failed jobs after PostgreSQL returns. `/health` reports PostgreSQL as down.
- **Redis unavailable or not ready:** Booking decisions fail closed with service-unavailable responses; the API does not make seat decisions from a local cache.
- **API or worker process exits:** The local supervisor restarts supervised processes. BullMQ can recover stalled work for a restarted worker.
- **Abandoned hold:** Redis expires the hold key and makes the seat available again.
- **Payment reconciliation:** The reconciler scans payment sessions and marks old paid sessions without the corresponding sale as `REFUND`. This is mock-payment bookkeeping, not a real payment-provider refund.

For production, add Redis replication/failover, health-aware ingress, real authentication, payment-provider reconciliation, monitoring, and a controlled admission/waiting-room strategy. The included local Compose stack and mock payment gateway are for development and testing, not a production deployment.

## Project layout

```text
backend/
  docker-compose.yml          Local Redis and PostgreSQL
  db/schema.sql               Booking and dead-letter schema
  src/
    config.js                 Validated configuration and Redis key builders
    app.js / server.js         Express app and API process startup
    redis.js / pg.js           Redis Lua registration and PostgreSQL pool
    lua/                       Atomic inventory, payment, and rate-limit scripts
    routes/                    Health, seat map, hold/release, payment, and book APIs
    services/                  Inventory, payment, and BullMQ queue logic
    rehydrate.js               Restore persisted sales to Redis
    socket.js                  Socket.IO and Redis Pub/Sub integration
  worker/
    persist.js                 BullMQ-to-Postgres persistence worker
    sweeper.js                 Missing/failed persistence job recovery
    reconciler.js              Stale payment-session reconciliation
  scripts/
    start-all.js               Local multi-process supervisor
    reset.js                   Clear event/test data and queue state
  loadtest/
    race.js                    Main concurrent booking load test
    verify.js                  Redis/Postgres consistency checks
    strict/                    Focused ordering, contention, and latency tests
```

## Load and strict tests

The tests use the configured event and database. **They are destructive:** `npm run reset` and the strict tests' resets clear booking/event state; reset also truncates `bookings` and `dead_letters` and obliterates the BullMQ queue. The race test then writes its bookings, which `npm run verify` checks. Do not run the sequence against data you need to keep. Start the local stack first with `npm run start:all`; the strict API tests require all three API ports, and the Redis-ordering test requires Redis.

The standard sequence is:

```sh
npm run reset
npm run loadtest
npm run verify
```

`npm run loadtest` runs `npm run strict:all` first, then `loadtest/race.js`. The race test launches 5,000 simulated users by default against 200 seats, with requests distributed across ports 3001–3003 using pooled HTTP connections. Tune `USERS`, `SEATS`, `HOST`, `PORTS`, and `CONNECTIONS` for the race run. A single-machine test is not a forecast of production capacity; results depend on the host, Redis/Postgres setup, request pool, and rate limits.

Individual test commands:

| Command | What it checks |
|---|---|
| `npm run strict:redis` | Redis Lua ordering: the first command on a single Redis connection wins the same-seat hold race. |
| `npm run strict:fcfs` | API winner rank under configured send-time spacing. `STAGGER_MS`, `CONTENDERS`, `TRIALS`, and `PORT` can be set; sub-5 ms results are informational because network jitter dominates. |
| `npm run strict:hot` | Many `/book` requests contest one seat across all three API instances; checks one winner, conflict responses, Redis sold count, and persisted rows. Set `CONTENDERS` and `TRIALS` to adjust the run. |
| `npm run strict:latency` | Hold-decision latency and outcome counts for a burst of 5,000 users. Set `USERS` to change the burst size. |
| `npm run strict:all` | Runs the four strict tests in order. |
| `npm run verify` | Waits for queue work to drain, then compares Redis sold bookings with PostgreSQL rows, checks duplicate seats and dead letters, and reports PASS/FAIL. |
| `npm run queue-test` | Runs BullMQ persistence, outage, retry, and sweeper regression cases. Requires Docker access because some cases stop/start the local `tickets-pg` container. |

First-come-first-served is defined by arrival order at Redis, which executes Lua scripts one at a time. Client send timestamps are only a proxy, so the API-level test reports win rates by spacing instead of claiming exact ordering at sub-millisecond resolution. Load-test latency and throughput are measurements of the test environment, not service-level guarantees.
