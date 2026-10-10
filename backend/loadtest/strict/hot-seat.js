// Proves one Redis seat cannot be sold twice when all API instances receive maximum contention.
// Every trial requires one BOOKED response, only SOLD/HELD conflicts, and one Redis sold entry.
// Then it waits for persistence and verifies Postgres has unique bookings with no duplicate seats.
'use strict';

const {
  closePools,
  config,
  createPools,
  positiveInteger,
  resetEventState,
  sendRequest,
  warmPools,
} = require('./common');
const { getQueue, closeQueue } = require('../../src/services/persistQueue');
const { redis, waitUntilReady } = require('../../src/redis');
const { pool, waitForPostgres } = require('../../src/pg');

const PORTS = (process.env.PORTS || '3001,3002,3003').split(',').map((port) => port.trim()).filter(Boolean);
const CONNECTIONS = positiveInteger('CONNECTIONS', 100);
const CONTENDERS = positiveInteger('CONTENDERS', 1000);
const TRIALS = positiveInteger('TRIALS', 20);
const pools = createPools(PORTS, CONNECTIONS);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function queueCounts() {
  const queue = await getQueue();
  return queue.getJobCounts('waiting', 'active', 'delayed', 'prioritized', 'waiting-children');
}

async function waitForPersistence(expected) {
  const deadline = process.hrtime.bigint() + 120_000_000_000n;
  while (process.hrtime.bigint() < deadline) {
    const [counts, rows] = await Promise.all([
      queueCounts(),
      pool.query('SELECT COUNT(*)::int AS n FROM bookings WHERE event_id = $1', [config.EVENT_ID]),
    ]);
    const pending = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']
      .reduce((total, state) => total + Number(counts[state] || 0), 0);
    if (pending === 0 && rows.rows[0].n === expected) return;
    await sleep(100);
  }
  throw new Error(`persistence did not drain with ${expected} Postgres rows before timeout`);
}

async function main() {
  if (PORTS.length === 0) throw new Error('PORTS must list at least one API instance');
  if (TRIALS > config.TOTAL_UNITS) throw new Error(`TRIALS must be <= TOTAL_UNITS (${config.TOTAL_UNITS})`);
  await resetEventState(redis);
  await waitUntilReady(redis);
  await waitForPostgres();
  await warmPools(pools, CONNECTIONS);

  let passed = true;
  for (let trial = 0; trial < TRIALS; trial += 1) {
    const unit = trial + 1;
    const soldBefore = await redis.hlen(config.soldKey());
    const requests = Array.from({ length: CONTENDERS }, (_, index) => {
      const userId = `hot-${trial}-u${index}`;
      const entry = pools[index % pools.length];
      return sendRequest(entry.pool, 'POST', '/book', {
        userId,
        body: { unit },
      }).then((result) => ({ ...result, index }));
    });
    const responses = await Promise.all(requests);
    const soldAfter = await redis.hlen(config.soldKey());
    const winners = responses.filter((result) => result.status === 200 && result.json?.status === 'BOOKED');
    const invalidConflicts = responses.filter((result) => !(
      (result.status === 200 && result.json?.status === 'BOOKED')
      || (result.status === 409 && ['SOLD', 'HELD'].includes(result.json?.reason))
    ));
    const oneSold = soldAfter - soldBefore === 1;
    const trialPassed = winners.length === 1 && invalidConflicts.length === 0 && oneSold;
    if (!trialPassed) {
      passed = false;
      console.error(`FAIL hot-seat trial ${trial + 1}: winners=${winners.length}, invalid=${invalidConflicts.length}, Redis sold delta=${soldAfter - soldBefore}`);
      if (invalidConflicts.length > 0) {
        const sample = invalidConflicts.slice(0, 5).map((result) => `${result.status}${result.error ? ` ${result.error.message}` : ` ${JSON.stringify(result.json)}`}`);
        console.error(`  invalid response sample: ${sample.join(' | ')}`);
      }
    } else {
      console.log(`PASS hot-seat trial ${trial + 1}/${TRIALS}: one booking, ${CONTENDERS - 1} SOLD/HELD conflicts`);
    }
  }

  const expectedSold = await redis.hlen(config.soldKey());
  await waitForPersistence(expectedSold);
  const [counts, bookings, duplicates, deadLetters, sold] = await Promise.all([
    queueCounts(),
    pool.query('SELECT COUNT(*)::int AS n, COUNT(DISTINCT booking_id)::int AS distinct_bookings FROM bookings WHERE event_id = $1', [config.EVENT_ID]),
    pool.query('SELECT unit_id FROM bookings WHERE event_id = $1 GROUP BY unit_id HAVING COUNT(*) > 1', [config.EVENT_ID]),
    pool.query('SELECT COUNT(*)::int AS n FROM dead_letters'),
    redis.hlen(config.soldKey()),
  ]);
  const pending = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children']
    .reduce((total, state) => total + Number(counts[state] || 0), 0);
  const persistencePassed = bookings.rows[0].n === TRIALS
    && bookings.rows[0].distinct_bookings === TRIALS
    && duplicates.rows.length === 0
    && deadLetters.rows[0].n === 0
    && sold === TRIALS
    && pending === 0;
  if (!persistencePassed) {
    passed = false;
    console.error(`FAIL hot-seat persistence: Postgres=${bookings.rows[0].n}, distinct=${bookings.rows[0].distinct_bookings}, duplicate seats=${duplicates.rows.length}, dead letters=${deadLetters.rows[0].n}, Redis sold=${sold}, pending jobs=${pending}`);
  } else {
    console.log(`PASS hot-seat persistence: Postgres=${TRIALS}, duplicates=0, dead letters=0`);
  }

  console.log(`${passed ? 'PASS' : 'FAIL'} hot-seat`);
  if (!passed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`FAIL hot-seat: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePools(pools);
    await Promise.all([
      closeQueue().catch(() => {}),
      redis.quit().catch(() => redis.disconnect()),
      pool.end().catch(() => {}),
    ]);
  });
