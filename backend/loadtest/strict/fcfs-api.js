// Measures API-level seat winners against millisecond-spaced client sends to one API instance.
// Reports winner rank and request send-time error across multiple staggers without claiming
// sub-millisecond client timestamps are the Redis arrival order.
'use strict';

const {
  closePools,
  config,
  createPools,
  dispatchRequest,
  hrtimeMs,
  positiveInteger,
  resetEventState,
  sendRequest,
  warmPools,
} = require('./common');

const HOST = process.env.HOST || '127.0.0.1';
const PORT = process.env.PORT || '3001';
const CONNECTIONS = 100;
const CONTENDERS = positiveInteger('CONTENDERS', 20);
const TRIALS = positiveInteger('TRIALS', 100);
const DEFAULT_STAGGER = Number(process.env.STAGGER_MS === undefined ? 5 : process.env.STAGGER_MS);
const STAGGERS_MS = [10, DEFAULT_STAGGER, 2, 1, 0.5, 5]
  .filter((value, index, values) => values.indexOf(value) === index)
  .sort((a, b) => b - a);
const pools = createPools([PORT], CONNECTIONS);

function spinUntil(deadline) {
  while (process.hrtime.bigint() < deadline) {
    // Busy-wait to schedule requests at the requested sub-millisecond offsets.
  }
}

async function runStagger(staggerMs) {
  await resetEventState();
  await warmPools(pools, CONNECTIONS);
  if (TRIALS > config.TOTAL_UNITS) throw new Error(`TRIALS must be <= TOTAL_UNITS (${config.TOTAL_UNITS})`);

  let rank0 = 0;
  let rank1 = 0;
  let rank2 = 0;
  let singleWinnerTrials = 0;
  let maxRank = -1;
  let sendErrorTotalMs = 0;
  let absoluteSendErrorTotalMs = 0;
  let requestCount = 0;

  for (let trial = 0; trial < TRIALS; trial += 1) {
    const unit = trial + 1;
    const start = process.hrtime.bigint();
    const sent = [];
    for (let index = 0; index < CONTENDERS; index += 1) {
      const scheduled = start + BigInt(Math.round(index * staggerMs * 1e6));
      spinUntil(scheduled);
      const result = dispatchRequest(pools[0].pool, 'POST', '/hold', {
        userId: `t${trial}-u${index}`,
        body: { unit },
      });
      const errorMs = hrtimeMs(scheduled, result.startedAt);
      sendErrorTotalMs += errorMs;
      absoluteSendErrorTotalMs += Math.abs(errorMs);
      requestCount += 1;
      sent.push({ index, userId: `t${trial}-u${index}`, promise: result.promise });
    }

    const responses = await Promise.all(sent.map(async ({ index, userId, promise }) => ({
      index,
      userId,
      ...(await promise),
    })));
    const winners = responses.filter((response) => response.status === 200 && response.json?.ok === true);
    if (winners.length === 1) {
      singleWinnerTrials += 1;
      const rank = winners[0].index;
      if (rank === 0) rank0 += 1;
      if (rank <= 1) rank1 += 1;
      if (rank <= 2) rank2 += 1;
      maxRank = Math.max(maxRank, rank);

      const release = await sendRequest(pools[0].pool, 'POST', '/release', {
        userId: winners[0].userId,
        body: { unit },
      });
      if (release.status !== 200 || release.json?.released !== true) {
        throw new Error(`failed to release unit ${unit} after trial ${trial + 1}: ${JSON.stringify(release.json)}`);
      }
    } else {
      console.error(`trial ${trial + 1}: expected one 200 winner, got ${winners.length}; statuses=${responses.map((r) => r.status).join(',')}`);
    }
  }

  const rank0Pct = (rank0 / TRIALS) * 100;
  const rank1Pct = (rank1 / TRIALS) * 100;
  const rank2Pct = (rank2 / TRIALS) * 100;
  const singlePct = (singleWinnerTrials / TRIALS) * 100;
  const meanError = requestCount ? sendErrorTotalMs / requestCount : 0;
  const meanAbsoluteError = requestCount ? absoluteSendErrorTotalMs / requestCount : 0;
  const summary = {
    staggerMs,
    rank0Pct,
    rank1Pct,
    rank2Pct,
    maxRank,
    singlePct,
    meanError,
    meanAbsoluteError,
  };
  return summary;
}

async function main() {
  if (!Number.isFinite(DEFAULT_STAGGER) || DEFAULT_STAGGER <= 0) {
    throw new Error('STAGGER_MS must be a positive number');
  }

  const summaries = [];
  let passed = true;
  for (const staggerMs of STAGGERS_MS) {
    const summary = await runStagger(staggerMs);
    summaries.push(summary);
    const measured = `rank 0=${summary.rank0Pct.toFixed(1)}%, rank <=1=${summary.rank1Pct.toFixed(1)}%, rank <=2=${summary.rank2Pct.toFixed(1)}%, max rank=${summary.maxRank < 0 ? 'none' : summary.maxRank}, exactly one winner=${summary.singlePct.toFixed(1)}%`;
    const timing = `mean send error=${summary.meanError.toFixed(3)} ms (absolute=${summary.meanAbsoluteError.toFixed(3)} ms)`;
    if (staggerMs >= 5) {
      const casePassed = summary.rank0Pct >= 95 && summary.singlePct === 100;
      console.log(`${casePassed ? 'PASS' : 'FAIL'} fcfs-api ${staggerMs}ms: ${measured}; ${timing}`);
      if (!casePassed) passed = false;
    } else {
      console.log(`INFO fcfs-api ${staggerMs}ms (network jitter dominates; no pass/fail at this spacing): ${measured}; ${timing}`);
    }
  }

  console.log('\nFCFS API summary');
  console.log('stagger | rank 0 | rank <=1 | rank <=2 | max rank | exactly one');
  for (const summary of summaries) {
    console.log(`${String(summary.staggerMs).padStart(7)} | ${summary.rank0Pct.toFixed(1).padStart(6)}% | ${summary.rank1Pct.toFixed(1).padStart(8)}% | ${summary.rank2Pct.toFixed(1).padStart(8)}% | ${String(summary.maxRank < 0 ? 'none' : summary.maxRank).padStart(8)} | ${summary.singlePct.toFixed(1)}%`);
  }
  console.log(`${passed ? 'PASS' : 'FAIL'} fcfs-api (criteria applied at >=5ms)`);
  if (!passed) process.exitCode = 1;
  await resetEventState();
}

main()
  .catch((error) => {
    console.error(`FAIL fcfs-api: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePools(pools);
  });
