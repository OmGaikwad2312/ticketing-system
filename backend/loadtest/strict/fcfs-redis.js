// Proves commands on one Redis connection reach the atomic hold Lua script in submission order.
// Each trial contests one free seat with 50 unique users; the first submitted user must win.
// Reports exact first-winner and single-winner rates across the configured trials.
'use strict';

const {
  config,
  positiveInteger,
  resetEventState,
} = require('./common');
const { redis, waitUntilReady } = require('../../src/redis');

const TRIALS = positiveInteger('TRIALS', 200);
const CONTENDERS = 50;
async function main() {
  if (TRIALS > config.TOTAL_UNITS) throw new Error(`TRIALS must be <= TOTAL_UNITS (${config.TOTAL_UNITS})`);
  await resetEventState(redis);
  await waitUntilReady(redis);

  let firstWinner = 0;
  let oneWinner = 0;
  const ttl = String(Number(process.env.HOLD_TTL_MS || config.HOLD_TTL_MS));
  const maxHolds = String(Number(process.env.MAX_HOLDS_PER_USER || config.MAX_HOLDS_PER_USER));
  const maxHoldTotal = String(Number(process.env.MAX_HOLD_TOTAL_MS || config.MAX_HOLD_TOTAL_MS));

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const unit = trial + 1;
    const pipeline = redis.pipeline();
    for (let index = 0; index < CONTENDERS; index += 1) {
      const userId = `u${index}`;
      pipeline.hold(
        config.soldKey(),
        config.holdKey(unit),
        config.readyKey(),
        config.userHoldsKey(userId),
        config.holdMaxKey(unit),
        String(unit),
        userId,
        ttl,
        maxHolds,
        maxHoldTotal,
        '',
      );
    }
    const replies = await pipeline.exec();
    const winners = [];
    for (let index = 0; index < replies.length; index += 1) {
      const [error, result] = replies[index];
      if (error) throw error;
      if (result === 'OK') winners.push(index);
    }

    if (winners.length === 1) oneWinner += 1;
    if (winners.length === 1 && winners[0] === 0) firstWinner += 1;

    for (const winner of winners) {
      const released = await redis.release(
        config.holdKey(unit),
        config.userHoldsKey(`u${winner}`),
        config.holdMaxKey(unit),
        `u${winner}`,
        '',
        String(unit),
      );
      if (released !== 1) throw new Error(`failed to release trial ${trial + 1} winner u${winner}`);
    }
  }

  const firstPct = (firstWinner / TRIALS) * 100;
  const onePct = (oneWinner / TRIALS) * 100;
  const passed = firstWinner === TRIALS && oneWinner === TRIALS;
  console.log(`fcfs-redis: trials=${TRIALS}, winner=u0 ${firstWinner}/${TRIALS} (${firstPct.toFixed(1)}%), exactly one winner ${oneWinner}/${TRIALS} (${onePct.toFixed(1)}%)`);
  console.log(`${passed ? 'PASS' : 'FAIL'} fcfs-redis`);
  if (!passed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`FAIL fcfs-redis: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await redis.quit().catch(() => redis.disconnect());
  });
