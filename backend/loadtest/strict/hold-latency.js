// Measures the Redis seat-lock decision path under 5000 simultaneous hold requests.
// Reports decision latency percentiles separately for held and contended responses plus throughput.
// Uses hold-only requests and resets afterward so the test leaves no holds or sales behind.
'use strict';

const {
  closePools,
  config,
  createPools,
  percentile,
  positiveInteger,
  resetEventState,
  sendRequest,
  warmPools,
} = require('./common');
const { redis } = require('../../src/redis');

const PORTS = (process.env.PORTS || '3001,3002,3003').split(',').map((port) => port.trim()).filter(Boolean);
const CONNECTIONS = positiveInteger('CONNECTIONS', 100);
const USERS = positiveInteger('USERS', 5000);
const pools = createPools(PORTS, CONNECTIONS);

async function main() {
  if (PORTS.length === 0) throw new Error('PORTS must list at least one API instance');
  await resetEventState(redis);
  await warmPools(pools, CONNECTIONS);

  const startedAt = process.hrtime.bigint();
  const requests = Array.from({ length: USERS }, (_, index) => {
    const entry = pools[index % pools.length];
    const userId = `latency-${process.pid}-${index}`;
    const unit = 1 + Math.floor(Math.random() * config.TOTAL_UNITS);
    return sendRequest(entry.pool, 'POST', '/hold', { userId, body: { unit } })
      .then((result) => ({ ...result, userId, unit, port: entry.port }));
  });

  const results = await Promise.all(requests);
  const finishedAt = process.hrtime.bigint();
  const durationMs = Number(finishedAt - startedAt) / 1e6;
  const by200 = results.filter((result) => result.status === 200 && result.json?.ok === true).map((result) => result.latencyMs).sort((a, b) => a - b);
  const by409 = results.filter((result) => result.status === 409).map((result) => result.latencyMs).sort((a, b) => a - b);
  const counts = {
    ok: by200.length,
    conflict: by409.length,
    rateLimited: results.filter((result) => result.status === 429).length,
    serverError: results.filter((result) => result.status >= 500).length,
    networkError: results.filter((result) => result.status === 0).length,
    other: results.filter((result) => result.status !== 0 && result.status !== 200 && result.status !== 409 && result.status !== 429 && result.status < 500).length,
  };
  const p99 = by200.length ? percentile(by200, 99) : Infinity;
  const noServerOrNetworkErrors = counts.serverError === 0 && counts.networkError === 0;
  const passed = p99 < 1000 && noServerOrNetworkErrors;

  console.log('\nHold latency (ms):');
  console.log(`  200 OK: p50=${percentile(by200, 50).toFixed(2)} p95=${percentile(by200, 95).toFixed(2)} p99=${p99.toFixed(2)} max=${(by200[by200.length - 1] || 0).toFixed(2)} n=${by200.length}`);
  console.log(`  409:    p50=${percentile(by409, 50).toFixed(2)} p95=${percentile(by409, 95).toFixed(2)} p99=${percentile(by409, 99).toFixed(2)} max=${(by409[by409.length - 1] || 0).toFixed(2)} n=${by409.length}`);
  console.log(`Throughput: ${USERS} requests in ${durationMs.toFixed(2)} ms (${(USERS / (durationMs / 1000)).toFixed(1)} req/s)`);
  console.log(`Responses: 200=${counts.ok} 409=${counts.conflict} 429=${counts.rateLimited} 5xx=${counts.serverError} network=${counts.networkError} other=${counts.other}`);
  console.log(`Seat-lock decision latency p99 = ${p99.toFixed(2)} ms (sub-second: ${p99 < 1000 ? 'YES' : 'NO'})`);

  await resetEventState(redis);
  console.log(`${passed ? 'PASS' : 'FAIL'} hold-latency`);
  if (!passed) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(`FAIL hold-latency: ${error.stack || error.message}`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePools(pools);
    await redis.quit().catch(() => redis.disconnect());
  });
