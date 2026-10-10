// End-to-end BullMQ persistence regressions. Run against the started stack after npm run reset.
'use strict';

const { spawn, spawnSync } = require('child_process');
const path = require('path');
const crypto = require('crypto');
const Redis = require('ioredis');
const { Worker } = require('bullmq');
const config = require('../src/config');
const { redis, waitUntilReady } = require('../src/redis');
const { pool, waitForPostgres } = require('../src/pg');
const inventory = require('../src/services/inventory');
const { enqueueBooking, getQueue, closeQueue } = require('../src/services/persistQueue');
const sweeper = require('../worker/sweeper');

const ROOT = path.resolve(__dirname, '..');
const API = process.env.QUEUE_TEST_API || 'http://localhost:3001';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const failures = [];

async function waitFor(check, { timeoutMs = 30000, intervalMs = 200, message = 'condition timed out' } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await sleep(intervalMs);
  }
  throw new Error(message);
}

async function requestBook(unit, userId) {
  const response = await fetch(`${API}/book`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-user-id': userId },
    body: JSON.stringify({ unit, bookingId: crypto.randomUUID() }),
  });
  return { status: response.status, body: await response.json() };
}

async function findFreeUnit(excluded = new Set()) {
  const seats = await inventory.getSeatMap();
  const seat = seats.find((item) => item.state === 'free' && !excluded.has(item.unit));
  if (!seat) throw new Error('No free Redis seat is available; run npm run reset first.');
  return seat.unit;
}

async function waitForBooking(bookingId, eventId = config.EVENT_ID, timeoutMs = 30000) {
  return waitFor(async () => {
    const result = await pool.query(
      'SELECT booking_id::text FROM bookings WHERE event_id = $1 AND booking_id = $2',
      [eventId, bookingId],
    );
    return result.rows.length === 1;
  }, { timeoutMs, message: `booking ${bookingId} was not persisted` });
}

async function runCase(name, test) {
  try {
    await test();
    console.log(`PASS ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL ${name}: ${error.message}`);
  }
}

async function makeDurableBooking(unit, userId) {
  const bookingId = crypto.randomUUID();
  const held = await inventory.holdSeat(unit, userId, bookingId);
  if (held !== 'OK') throw new Error(`hold returned ${held} for unit ${unit}`);
  const confirmed = await redis.confirm(
    config.soldKey(),
    config.holdKey(unit),
    config.bookingKey(bookingId),
    String(unit),
    userId,
    bookingId,
    config.EVENT_ID,
    String(config.BOOKING_RECORD_TTL_MS),
  );
  if (confirmed !== 'OK') throw new Error(`direct confirm returned ${confirmed}`);
  return bookingId;
}

function waitForOutput(child, text, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error(`child did not emit ${text}; output=${output}`)), timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      output += chunk;
      if (output.includes(text)) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`child exited ${code}; output=${output}`));
    });
  });
}

function startCrashTestWorker(queueName, jobDelayMs) {
  const script = [
    "const { Worker } = require('bullmq');",
    "const Redis = require('ioredis');",
    "const { Pool } = require('pg');",
    "const config = require('./src/config');",
    'const connection = new Redis(config.REDIS_URL, { maxRetriesPerRequest: null });',
    'const pool = new Pool({ connectionString: config.DATABASE_URL, max: 2 });',
    `const worker = new Worker(${JSON.stringify(queueName)}, async (job) => {`,
    `  await new Promise((resolve) => setTimeout(resolve, ${jobDelayMs}));`,
    "  const { bookingId, unit, userId, eventId } = job.data;",
    "  await pool.query('INSERT INTO bookings (booking_id,event_id,unit_id,user_id) VALUES ($1,$2,$3,$4) ON CONFLICT (booking_id) DO NOTHING', [bookingId,eventId,unit,userId]);",
    '}, { connection, prefix: config.BULL_PREFIX, lockDuration: 1000, stalledInterval: 1000, maxStalledCount: 5 });',
    "worker.on('active', () => console.log('ACTIVE'));",
    "worker.on('error', (error) => console.error(error));",
    "worker.waitUntilReady().then(() => console.log('READY'));",
  ].join('\n');
  return spawn(process.execPath, ['-e', script], { cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
}

async function main() {
  await waitUntilReady(redis);
  await waitForPostgres();
  const health = await fetch(`${API}/health`).then((response) => response.json());
  if (health.redis !== 'ok') throw new Error(`API at ${API} is not ready: ${JSON.stringify(health)}`);

  await runCase('Q1 idempotent enqueue creates one Postgres row', async () => {
    const bookingId = crypto.randomUUID();
    const eventId = `queue-q1-${process.pid}`;
    const data = { bookingId, unit: 1, userId: 'queue-test', eventId };
    await Promise.all(Array.from({ length: 5 }, () => enqueueBooking(data)));
    await waitForBooking(bookingId, eventId);
    const { rows } = await pool.query('SELECT COUNT(*)::int AS n FROM bookings WHERE event_id = $1 AND booking_id = $2', [eventId, bookingId]);
    if (rows[0].n !== 1) throw new Error(`expected 1 row, got ${rows[0].n}`);
    const dead = await pool.query("SELECT COUNT(*)::int AS n FROM dead_letters WHERE payload->>'bookingId' = $1", [bookingId]);
    if (dead.rows[0].n !== 0) throw new Error(`expected 0 dead letters, got ${dead.rows[0].n}`);
  });

  await runCase('Q2 sweeper recovers a deleted queue job', async () => {
    const unit = await findFreeUnit();
    const queue = await getQueue();
    await queue.pause();
    let bookingId;
    try {
      const result = await requestBook(unit, `queue-q2-${process.pid}`);
      if (result.status !== 200) throw new Error(`book returned ${result.status} ${JSON.stringify(result.body)}`);
      bookingId = result.body.bookingId;
      await queue.obliterate({ force: true });
    } finally {
      await queue.resume();
    }
    await sleep(config.SWEEP_GRACE_MS + 100);
    await sweeper.scanSoldBookings();
    await waitForBooking(bookingId);
  });

  await runCase('Q3 bookings succeed while Postgres is unavailable', async () => {
    const units = [];
    for (let index = 0; index < 5; index += 1) units.push(await findFreeUnit(new Set(units)));
    const stop = spawnSync('docker', ['stop', 'tickets-pg'], { encoding: 'utf8' });
    if (stop.status !== 0) throw new Error(`docker stop tickets-pg failed: ${stop.stderr || stop.stdout}`);
    let startError = null;
    try {
      for (let index = 0; index < units.length; index += 1) {
        const result = await requestBook(units[index], `queue-q3-${process.pid}-${index}`);
        if (result.status !== 200 || result.body.status !== 'BOOKED') {
          throw new Error(`unit ${units[index]} returned ${result.status} ${JSON.stringify(result.body)}`);
        }
      }
    } finally {
      const start = spawnSync('docker', ['start', 'tickets-pg'], { encoding: 'utf8' });
      if (start.status !== 0) startError = new Error(`docker start tickets-pg failed: ${start.stderr || start.stdout}`);
    }
    if (startError) throw startError;
    await waitForPostgres({ maxWaitMs: 60000 });
    for (const unit of units) {
      const soldId = await redis.hget(config.soldKey(), String(unit));
      await waitForBooking(soldId, config.EVENT_ID, 60000);
    }
    const persisted = await pool.query(
      'SELECT COUNT(*)::int AS n FROM bookings WHERE event_id = $1 AND unit_id = ANY($2::int[])',
      [config.EVENT_ID, units],
    );
    if (persisted.rows[0].n !== units.length) throw new Error(`expected ${units.length} persisted rows, got ${persisted.rows[0].n}`);
  });

  await runCase('Q4 stalled BullMQ job is redelivered after worker crash', async () => {
    const queueName = `${config.PERSIST_QUEUE_NAME}-crash-test-${process.pid}`;
    const queue = new (require('bullmq').Queue)(queueName, {
      connection: new Redis(config.REDIS_URL, { maxRetriesPerRequest: 1, enableOfflineQueue: false }),
      prefix: config.BULL_PREFIX,
    });
    const bookingId = crypto.randomUUID();
    const eventId = `queue-q4-${process.pid}`;
    const data = { bookingId, unit: 1, userId: 'crash-test', eventId };
    let first = startCrashTestWorker(queueName, 10000);
    try {
      await waitForOutput(first, 'READY');
      await queue.add('persist', data, { jobId: bookingId, attempts: 3 });
      await waitForOutput(first, 'ACTIVE');
      const firstExit = new Promise((resolve) => first.once('exit', resolve));
      first.kill();
      await firstExit;
      const replacement = startCrashTestWorker(queueName, 0);
      try {
        await waitForOutput(replacement, 'READY');
        await waitForBooking(bookingId, eventId, 20000);
      } finally {
        replacement.kill();
        await new Promise((resolve) => replacement.once('exit', resolve));
      }
    } finally {
      if (first.exitCode === null) first.kill();
      await queue.obliterate({ force: true }).catch(() => {});
      await queue.close();
    }
  });

  await runCase('Q5 seat conflict dead-letters and heals Redis to Postgres winner', async () => {
    const unit = await findFreeUnit();
    const winnerId = crypto.randomUUID();
    const loserId = crypto.randomUUID();
    await pool.query(
      'INSERT INTO bookings (booking_id,event_id,unit_id,user_id) VALUES ($1,$2,$3,$4)',
      [winnerId, config.EVENT_ID, unit, 'winner'],
    );
    await redis.hset(config.soldKey(), String(unit), loserId);
    await redis.hset(config.payKey(loserId), 'user', 'loser', 'unit', String(unit), 'status', 'PAID');
    await redis.pexpire(config.payKey(loserId), config.PAID_SESSION_TTL_MS);
    await enqueueBooking({ bookingId: loserId, unit, userId: 'loser', eventId: config.EVENT_ID });
    await waitFor(async () => {
      const result = await pool.query("SELECT 1 FROM dead_letters WHERE payload->>'bookingId' = $1", [loserId]);
      return result.rows.length === 1;
    }, { message: 'seat conflict was not dead-lettered' });
    if (await redis.hget(config.soldKey(), String(unit)) !== winnerId) throw new Error('sold hash was not repaired to the Postgres winner');
    if ((await redis.hget(config.payKey(loserId), 'status')) !== 'REFUND') throw new Error('loser payment was not marked REFUND');
  });

  await runCase('Q6 direct confirm without enqueue is recovered by sweeper', async () => {
    const unit = await findFreeUnit();
    const bookingId = await makeDurableBooking(unit, `queue-q6-${process.pid}`);
    await sleep(config.SWEEP_GRACE_MS + 100);
    await sweeper.scanSoldBookings();
    await waitForBooking(bookingId);
  });

  await runCase('Q7 load test bookings succeed while persistence queue is paused', async () => {
    const reset = spawnSync(process.execPath, ['scripts/reset.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 2_000_000 });
    if (reset.status !== 0) throw new Error(`reset failed: ${reset.stderr || reset.stdout}`);
    const queue = await getQueue();
    await queue.pause();
    let load;
    try {
      load = spawnSync(process.execPath, ['loadtest/race.js'], {
        cwd: ROOT,
        encoding: 'utf8',
        maxBuffer: 5_000_000,
        env: { ...process.env, USERS: '5000', SEATS: String(config.TOTAL_UNITS) },
      });
    } finally {
      await queue.resume();
    }
    if (load.status !== 0) throw new Error(`load test failed: ${load.stderr || load.stdout}`);
    await waitFor(async () => {
      const current = await getCounts();
      return Number(current.waiting || 0) + Number(current.active || 0) + Number(current.delayed || 0) + Number(current.prioritized || 0) === 0;
    }, { timeoutMs: 60000, message: 'BullMQ jobs did not drain after resume' });
    const verify = spawnSync(process.execPath, ['loadtest/verify.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 2_000_000 });
    if (verify.status !== 0) throw new Error(`verify failed: ${verify.stdout || verify.stderr}`);
    if (!/200 BOOKED/.test(load.stdout)) throw new Error(`load test did not report 200 BOOKED: ${load.stdout}`);
  });

  await runCase('Q8 exhausted persistence jobs are recovered by the sweeper', async () => {
    const reset = spawnSync(process.execPath, ['scripts/reset.js'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 2_000_000 });
    if (reset.status !== 0) throw new Error(`reset failed: ${reset.stderr || reset.stdout}`);

    const units = [];
    for (let index = 0; index < 3; index += 1) units.push(await findFreeUnit(new Set(units)));

    const stop = spawnSync('docker', ['stop', 'tickets-pg'], { encoding: 'utf8' });
    if (stop.status !== 0) throw new Error(`docker stop tickets-pg failed: ${stop.stderr || stop.stdout}`);

    const bookingIds = [];
    let startError = null;
    try {
      for (let index = 0; index < units.length; index += 1) {
        const result = await requestBook(units[index], `queue-q8-${process.pid}-${index}`);
        if (result.status !== 200 || result.body.status !== 'BOOKED') {
          throw new Error(`unit ${units[index]} returned ${result.status} ${JSON.stringify(result.body)}`);
        }
        bookingIds.push(result.body.bookingId);
      }

      const queue = await getQueue();
      const retryDelayMs = Array.from({ length: Math.max(0, config.JOB_ATTEMPTS - 1) }, (_, index) => (
        Math.min(1000 * (2 ** index), config.JOB_BACKOFF_CAP_MS)
      )).reduce((sum, delay) => sum + delay, 0);
      const exhaustedTimeoutMs = retryDelayMs + config.JOB_ATTEMPTS * 15000 + 30000;

      await waitFor(async () => {
        for (const bookingId of bookingIds) {
          const job = await queue.getJob(bookingId);
          if (!job) throw new Error(`booking ${bookingId} has no persistence job`);
          if (job.opts.attempts !== config.JOB_ATTEMPTS) {
            throw new Error(`booking ${bookingId} has ${job.opts.attempts} attempts; restart API and workers with JOB_ATTEMPTS=${config.JOB_ATTEMPTS}`);
          }
          if (await job.getState() !== 'failed' || job.attemptsMade < config.JOB_ATTEMPTS) return false;
        }
        return true;
      }, {
        timeoutMs: exhaustedTimeoutMs,
        intervalMs: 300,
        message: `the ${bookingIds.length} persistence jobs did not exhaust their retries`,
      });
    } finally {
      const start = spawnSync('docker', ['start', 'tickets-pg'], { encoding: 'utf8' });
      if (start.status !== 0) startError = new Error(`docker start tickets-pg failed: ${start.stderr || start.stdout}`);
    }
    if (startError) throw startError;

    await waitForPostgres({ maxWaitMs: 60000 });
    const allBookingsPersisted = async () => {
      const result = await pool.query(
        'SELECT COUNT(*)::int AS rows, COUNT(DISTINCT booking_id)::int AS unique_bookings FROM bookings WHERE event_id = $1 AND booking_id = ANY($2::uuid[])',
        [config.EVENT_ID, bookingIds],
      );
      return result.rows[0].rows === bookingIds.length
        && result.rows[0].unique_bookings === bookingIds.length;
    };

    let persisted = false;
    for (let cycle = 1; cycle <= 2; cycle += 1) {
      await sweeper.scanSoldBookings();
      try {
        await waitFor(allBookingsPersisted, {
          timeoutMs: config.SWEEP_INTERVAL_MS,
          intervalMs: 200,
          message: `bookings were not persisted during sweeper cycle ${cycle}`,
        });
        persisted = true;
        break;
      } catch (error) {
        if (cycle === 2) throw error;
      }
    }
    if (!persisted) throw new Error('bookings were not persisted within two sweeper cycles');

    const duplicateUnits = await pool.query(
      'SELECT unit_id FROM bookings WHERE event_id = $1 AND booking_id = ANY($2::uuid[]) GROUP BY unit_id HAVING COUNT(*) > 1',
      [config.EVENT_ID, bookingIds],
    );
    if (duplicateUnits.rows.length > 0) throw new Error(`found duplicate booking rows for units ${duplicateUnits.rows.map((row) => row.unit_id).join(', ')}`);

    const deadLetters = await pool.query('SELECT COUNT(*)::int AS n FROM dead_letters');
    if (deadLetters.rows[0].n !== 0) throw new Error(`expected no dead letters, got ${deadLetters.rows[0].n}`);
  });

  console.log(`\n${failures.length ? `${failures.length} regression case(s) failed` : 'All queue regressions passed'}`);
  if (failures.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`queue regression crashed: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeQueue().catch(() => {});
    await Promise.all([redis.quit().catch(() => {}), pool.end().catch(() => {})]);
  });