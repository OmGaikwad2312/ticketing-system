// Verify BullMQ persistence has drained and every Redis sold booking matches durable Postgres state.
'use strict';

const config = require('../src/config');
const { redis, waitUntilReady } = require('../src/redis');
const { pool, waitForPostgres } = require('../src/pg');
const { getCounts, closeQueue } = require('../src/services/persistQueue');

const TIMEOUT_MS = 30000;
const POLL_MS = 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const pendingCount = (queueCounts) => (
  Number(queueCounts.waiting || 0)
  + Number(queueCounts.active || 0)
  + Number(queueCounts.delayed || 0)
  + Number(queueCounts.prioritized || 0)
);

async function counts() {
  const [sold, result] = await Promise.all([
    redis.hgetall(config.soldKey()),
    pool.query('SELECT COUNT(*)::int AS n FROM bookings WHERE event_id = $1', [config.EVENT_ID]),
  ]);
  return { sold, redisSold: Object.keys(sold).length, pgCount: result.rows[0].n };
}

async function main() {
  await waitUntilReady(redis);
  await waitForPostgres({ maxWaitMs: TIMEOUT_MS });

  const started = Date.now();
  let drained = false;
  let snapshot;
  let queueCounts;
  process.stdout.write('Waiting for BullMQ jobs to drain and Postgres to catch up');
  for (;;) {
    [queueCounts, snapshot] = await Promise.all([getCounts(), counts()]);
    drained = pendingCount(queueCounts) === 0 && snapshot.redisSold === snapshot.pgCount;
    if (drained || Date.now() - started > TIMEOUT_MS) break;
    process.stdout.write('.');
    await sleep(POLL_MS);
  }
  console.log(drained ? ` drained in ${((Date.now() - started) / 1000).toFixed(1)} s` : ` TIMEOUT after ${TIMEOUT_MS / 1000} s`);

  [queueCounts, snapshot] = await Promise.all([getCounts(), counts()]);
  const { sold, redisSold, pgCount } = snapshot;
  const dup = await pool.query(
    'SELECT unit_id, COUNT(*)::int AS n FROM bookings WHERE event_id = $1 GROUP BY unit_id HAVING COUNT(*) > 1',
    [config.EVENT_ID],
  );
  const dead = await pool.query('SELECT COUNT(*)::int AS n FROM dead_letters');
  const deadLetters = dead.rows[0].n;
  const pgRows = await pool.query('SELECT unit_id, booking_id FROM bookings WHERE event_id = $1', [config.EVENT_ID]);
  const pgMap = new Map(pgRows.rows.map((row) => [String(row.unit_id), String(row.booking_id)]));
  const mismatches = [];
  for (const [unit, bookingId] of Object.entries(sold)) {
    if (pgMap.get(unit) !== bookingId) mismatches.push(`unit ${unit}: redis=${bookingId} pg=${pgMap.get(unit) || 'missing'}`);
  }
  for (const [unit, bookingId] of pgMap) {
    if (!(unit in sold)) mismatches.push(`unit ${unit}: redis=missing pg=${bookingId}`);
  }

  console.log('\n' + '='.repeat(72));
  console.log(' VERIFY');
  console.log('='.repeat(72));
  console.log(`  Redis sold count (HLEN ${config.soldKey()}) : ${redisSold}`);
  console.log(`  Postgres bookings count                : ${pgCount}`);
  console.log(`  Seat capacity (TOTAL_UNITS)            : ${config.TOTAL_UNITS}`);
  console.log(`  Duplicate seats in Postgres            : ${dup.rows.length}${dup.rows.length ? '  <-- ' + dup.rows.map((row) => `unit ${row.unit_id} x${row.n}`).join(', ') : ''}`);
  console.log(`  dead_letters rows                      : ${deadLetters}`);
  console.log(`  Redis<->Postgres row mismatches        : ${mismatches.length}`);
  console.log(`  BullMQ counts (waiting/active/delayed/prioritized): ${queueCounts.waiting || 0}/${queueCounts.active || 0}/${queueCounts.delayed || 0}/${queueCounts.prioritized || 0}`);
  console.log(`  BullMQ counts (completed/failed)       : ${queueCounts.completed || 0}/${queueCounts.failed || 0}`);
  for (const mismatch of mismatches.slice(0, 10)) console.log(`    - ${mismatch}`);

  const checks = [
    [pendingCount(queueCounts) === 0, 'BullMQ pending work is drained'],
    [redisSold === pgCount, `Redis sold (${redisSold}) == Postgres (${pgCount})`],
    [dup.rows.length === 0, 'no duplicate seats'],
    [deadLetters === 0, 'no dead letters'],
    [pgCount <= config.TOTAL_UNITS, `Postgres count (${pgCount}) <= capacity (${config.TOTAL_UNITS})`],
    [mismatches.length === 0, 'Redis and Postgres agree on every (unit, bookingId)'],
  ];
  console.log('');
  for (const [ok, text] of checks) console.log(`  [${ok ? 'x' : ' '}] ${text}`);
  const passed = drained && checks.every(([ok]) => ok);

  console.log('\n' + '='.repeat(72));
  console.log(passed ? ' PASS - zero double bookings, Redis and Postgres consistent' : ' FAIL - see the unchecked items above');
  console.log('='.repeat(72));
  return passed;
}

main()
  .then(async (passed) => {
    await closeQueue();
    await Promise.all([redis.quit().catch(() => {}), pool.end().catch(() => {})]);
    process.exit(passed ? 0 : 1);
  })
  .catch(async (error) => {
    console.error('verify crashed:', error.message);
    await closeQueue();
    await Promise.all([redis.quit().catch(() => {}), pool.end().catch(() => {})]);
    process.exit(1);
  });