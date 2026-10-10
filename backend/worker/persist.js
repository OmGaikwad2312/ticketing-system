// BullMQ worker: persist confirmed Redis booking records into Postgres with retryable, idempotent inserts.
'use strict';

const { Worker, UnrecoverableError } = require('bullmq');
const { Pool } = require('pg');
const config = require('../src/config');
const { redis, createBullConnection, waitUntilReady } = require('../src/redis');
const { deadLetter } = require('../src/services/deadLetter');

const TAG = `[persist-${config.WORKER_ID}]`;
const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  connectionTimeoutMillis: 3000,
  idleTimeoutMillis: 30000,
  query_timeout: 10000,
});
let worker = null;
let stopping = false;

pool.on('error', (error) => console.error(`${TAG} postgres pool error: ${error.message}`));

async function processBooking(job) {
  const { bookingId, unit, userId, eventId } = job.data;
  try {
    await pool.query(
      `INSERT INTO bookings (booking_id, event_id, unit_id, user_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (booking_id) DO NOTHING`,
      [bookingId, eventId, Number(unit), userId],
    );
  } catch (error) {
    if (error.code === '23505' && error.constraint !== 'bookings_booking_id_key') {
      throw new UnrecoverableError('SEAT_CONFLICT');
    }
    throw error;
  }

  await redis.del(config.bookingKey(bookingId)).catch((error) => {
    console.error(`${TAG} persisted ${bookingId}, but booking-record cleanup failed: ${error.message}`);
  });
  console.log(`persisted ${bookingId} unit ${unit} by ${config.WORKER_ID}`);
  return { bookingId, unit };
}

async function startWorker() {
  await waitUntilReady(redis);
  worker = new Worker(config.PERSIST_QUEUE_NAME, processBooking, {
    connection: createBullConnection('worker'),
    prefix: config.BULL_PREFIX,
    concurrency: config.WORKER_CONCURRENCY,
    stalledInterval: config.STALLED_INTERVAL_MS,
    maxStalledCount: 5,
    settings: {
      backoffStrategy: (attemptsMade) => Math.min(1000 * 2 ** (attemptsMade - 1), config.JOB_BACKOFF_CAP_MS),
    },
  });

  worker.on('error', (error) => console.error(`${TAG} worker error: ${error.message}`));
  worker.on('stalled', (jobId) => console.warn(`${TAG} job ${jobId} stalled and will be retried`));
  worker.on('failed', async (job, error) => {
    if (!job) return;
    if (error instanceof UnrecoverableError) {
      try {
        await deadLetter(job, error, pool);
      } catch (deadLetterError) {
        console.error(`${TAG} unable to dead-letter ${job.id}: ${deadLetterError.message}`);
      }
      return;
    }
    const attempts = job.opts.attempts || config.JOB_ATTEMPTS;
    if (job.attemptsMade >= attempts) {
      console.warn(`persist job ${job.data.bookingId} exhausted retries, left for the sweeper`);
    }
  });

  await worker.waitUntilReady();
  console.log(`${TAG} consuming BullMQ queue ${config.PERSIST_QUEUE_NAME} (concurrency=${config.WORKER_CONCURRENCY})`);
}

async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  console.log(`${TAG} ${signal} received, draining active jobs...`);
  try {
    if (worker) await worker.close();
    await redis.quit().catch(() => redis.disconnect());
    await pool.end();
  } catch (error) {
    console.error(`${TAG} shutdown error: ${error.message}`);
  }
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => {
  console.error(`${TAG} unhandled rejection:`, reason && reason.stack ? reason.stack : reason);
});

if (require.main === module) {
  startWorker().catch((error) => {
    console.error(`${TAG} fatal: ${error.stack || error.message}`);
    process.exit(1);
  });
}

module.exports = { processBooking, startWorker };