// Recovery process that re-enqueues confirmed Redis sales whose BullMQ delivery was lost.
'use strict';

const config = require('../src/config');
const { redis, waitUntilReady } = require('../src/redis');
const { pool, waitForPostgres } = require('../src/pg');
const { enqueueBooking, getQueue, closeQueue } = require('../src/services/persistQueue');

const TAG = '[sweeper]';
let stopping = false;
let running = false;
let lastError = null;

async function scanSoldBookings() {
  const { rows } = await pool.query(
    'SELECT booking_id::text FROM bookings WHERE event_id = $1',
    [config.EVENT_ID],
  );
  const persisted = new Set(rows.map((row) => row.booking_id));
  const [seconds, microseconds] = await redis.time();
  const nowMs = Number(seconds) * 1000 + Math.floor(Number(microseconds) / 1000);
  let cursor = '0';
  let queue = null;
  let retried = 0;
  let requeued = 0;

  do {
    const [nextCursor, fields] = await redis.hscan(config.soldKey(), cursor, 'COUNT', 500);
    cursor = nextCursor;
    for (let index = 0; index < fields.length; index += 2) {
      const unit = Number(fields[index]);
      const bookingId = fields[index + 1];
      if (persisted.has(bookingId)) continue;

      const record = await redis.hgetall(config.bookingKey(bookingId));
      if (!record || Object.keys(record).length === 0) {
        console.error(`${TAG} ALERT: sold seat ${unit} booking ${bookingId} has no record and is not in Postgres`);
        continue;
      }
      if (nowMs - Number(record.confirmedAt) <= config.SWEEP_GRACE_MS) continue;

      if (!queue) queue = await getQueue();
      const job = await queue.getJob(bookingId);
      if (job) {
        const state = await job.getState();
        if (state === 'failed') {
          await job.retry();
          retried += 1;
          continue;
        }
        if (state === 'completed') {
          const result = await pool.query(
            'SELECT 1 FROM bookings WHERE event_id = $1 AND booking_id = $2',
            [record.event || config.EVENT_ID, bookingId],
          );
          if (result.rows.length > 0) {
            persisted.add(bookingId);
            continue;
          }
          await job.remove();
        } else if (!['waiting', 'active', 'delayed', 'prioritized', 'waiting-children'].includes(state)) {
          throw new Error(`unexpected BullMQ state "${state}" for booking ${bookingId}`);
        } else {
          continue;
        }
      }

      await enqueueBooking({
        bookingId,
        unit: Number(record.unit || unit),
        userId: record.user,
        eventId: record.event || config.EVENT_ID,
      });
      requeued += 1;
    }
  } while (cursor !== '0');

  const recovered = retried + requeued;
  if (recovered > 0) {
    console.log(`${TAG} recovered ${recovered} unpersisted booking${recovered === 1 ? '' : 's'} (retried ${retried}, re-enqueued ${requeued})`);
  }
  return recovered;
}

async function tick() {
  if (running || stopping) return 0;
  running = true;
  try {
    const result = await scanSoldBookings();
    lastError = null;
    return result;
  } catch (error) {
    const message = error.message || String(error);
    if (message !== lastError) {
      lastError = message;
      console.error(`${TAG} sweep skipped: ${message}`);
    }
    return 0;
  } finally {
    running = false;
  }
}

async function main() {
  await waitUntilReady(redis);
  await waitForPostgres();
  await tick();
  const timer = setInterval(() => void tick(), config.SWEEP_INTERVAL_MS);

  async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    clearInterval(timer);
    console.log(`${TAG} ${signal} received, stopping`);
    await Promise.all([
      closeQueue(),
      redis.quit().catch(() => redis.disconnect()),
      pool.end().catch(() => {}),
    ]);
    process.exit(0);
  }
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  console.log(`${TAG} running every ${config.SWEEP_INTERVAL_MS}ms`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`${TAG} fatal: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { scanSoldBookings, tick };