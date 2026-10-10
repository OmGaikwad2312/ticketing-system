# Persistence and Recovery Drills

Run these one at a time from `backend/`. Start the stack in terminal A with `npm run start:all`;
run each drill in terminal B. Start with `npm run reset` only when you are willing to clear the
current event bookings. Each drill should finish with `npm run verify` reporting **PASS**.

The system's recovery source is the Redis sold hash plus the booking-record hash written inside
`confirm.lua`. BullMQ transports work to Postgres; the sweeper repairs lost delivery jobs.

## 1. Kill a Persistence Worker

Run the load test, then terminate one `persist-w*` PID printed by `start-all` while jobs are active:

```powershell
npm run reset
Start-Process npm -ArgumentList 'run','loadtest'
taskkill /PID <persist-worker-pid> /F
npm run verify
```

BullMQ detects a stalled job and makes it available to the other worker. The supervisor restarts
the killed process. Postgres inserts are idempotent, so a job that completed its insert before the
worker died can safely be retried.

## 2. Stop Postgres Briefly

```powershell
npm run reset
docker stop tickets-pg
curl.exe -X POST http://localhost:3001/book -H "content-type: application/json" -H "x-user-id: chaos-user" -d '{"unit":1}'
docker start tickets-pg
npm run verify
```

Booking confirmation remains Redis-only and can still return `200 BOOKED`. Persistence jobs retry
with capped backoff, and the Redis booking records remain available while Postgres is down.

## 3. Restart Redis

```powershell
npm run reset
docker restart tickets-redis
curl.exe http://localhost:3001/health
npm run verify
```

The API fails closed while Redis reconnects, then rehydrates the sold hash from Postgres. Redis is
configured with AOF fsync on every write and `noeviction` for BullMQ.

## 4. Delete Queue Data Before the Sweeper Runs

After confirming a booking, but before it is persisted, obliterate BullMQ queue data:

```powershell
node -e "const c=require('./src/config'); const {getQueue,closeQueue}=require('./src/services/persistQueue'); (async()=>{const q=await getQueue(); await q.obliterate({force:true}); await closeQueue()})().catch(e=>{console.error(e);process.exit(1)})()"
npm run verify
```

The sweeper scans the sold hash. Once the corresponding booking record is older than
`SWEEP_GRACE_MS`, it re-enqueues the same booking ID. Verify waits until BullMQ has no pending work
and Postgres matches Redis.

## 5. Let a Hold Expire

Start a temporary API with a short hold lifetime:

```powershell
$env:HOLD_TTL_MS=5000; $env:PORT=3004; node src/server.js
```

In another terminal, call `POST /hold`, inspect the seat with `GET /seats`, wait for the TTL, then
inspect it again. Redis key expiry returns the unit to `free`; no Postgres call is involved.

## 6. Stop One API Instance

Terminate one API PID printed by `start-all` during a load test. The other ports continue serving,
and the supervisor restarts the failed instance. Verify after the load test completes.

## 7. Exercise a Seat-Conflict Dead Letter

Create a Postgres booking for a unit, then enqueue a different booking ID for the same event/unit.
After retries terminate, the job is dead-lettered, the sold hash is repaired from Postgres, and the
losing payment session is marked `REFUND` if it still exists. `dead_letters` records the conflict.