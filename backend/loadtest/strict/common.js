// Shared reset, connection warm-up, and request helpers for strict tests.
// Ensures tests use the backend's configured Redis keys and the required API headers.
// Keeps request dispatch timestamps and response latency measurements on hrtime.bigint().
'use strict';

const { spawnSync } = require('child_process');
const path = require('path');
const { Pool } = require('undici');
const config = require('../../src/config');

const ROOT = path.resolve(__dirname, '../..');
const HOST = process.env.HOST || '127.0.0.1';

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] === undefined ? fallback : process.env[name]);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

function createPools(ports, connections) {
  return ports.map((port) => ({
    port: String(port),
    pool: new Pool(`http://${HOST}:${port}`, {
      connections,
      pipelining: 1,
      keepAliveTimeout: 60000,
      headersTimeout: 60000,
      bodyTimeout: 60000,
    }),
  }));
}

function dispatchRequest(pool, method, pathname, { userId, body } = {}) {
  const options = {
    method,
    path: pathname,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(userId ? { 'x-user-id': userId } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  };
  const startedAt = process.hrtime.bigint();
  let request;
  try {
    request = pool.request(options);
  } catch (error) {
    request = Promise.reject(error);
  }
  const promise = (async () => {
    try {
      const response = await request;
      const text = await response.body.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch (_) {
        // Preserve the HTTP status and report an invalid response body to the test.
      }
      const finishedAt = process.hrtime.bigint();
      return {
        status: response.statusCode,
        json,
        startedAt,
        latencyMs: Number(finishedAt - startedAt) / 1e6,
      };
    } catch (error) {
      const finishedAt = process.hrtime.bigint();
      return {
        status: 0,
        json: null,
        error,
        startedAt,
        latencyMs: Number(finishedAt - startedAt) / 1e6,
      };
    }
  })();
  return { startedAt, promise };
}

function sendRequest(pool, method, pathname, options) {
  return dispatchRequest(pool, method, pathname, options).promise;
}

async function warmPools(entries, connections) {
  for (const entry of entries) {
    const checks = await Promise.all(Array.from({ length: connections }, () => (
      sendRequest(entry.pool, 'GET', '/health')
    )));
    for (const result of checks) {
      if (result.status === 0 || !['ok', 'not_ready'].includes(result.json?.redis)) {
        throw new Error(`API ${entry.port} failed health warm-up: ${result.error?.message || JSON.stringify(result.json)}`);
      }
    }
    console.log(`warmed ${connections} keep-alive connections to ${entry.port}`);
  }
}

async function resetEventState(redis = null) {
  const result = spawnSync(process.execPath, ['scripts/reset.js'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 2_000_000,
  });
  if (result.status !== 0) {
    throw new Error(`event reset failed: ${result.stderr || result.stdout || result.error?.message}`);
  }

  if (redis) {
    const { waitUntilReady } = require('../../src/redis');
    await waitUntilReady(redis);
    const sold = await redis.hlen(config.soldKey());
    const holdKeys = await scanKeys(redis, `evt:{${config.EVENT_ID}}:hold:*`);
    const userHoldKeys = await scanKeys(redis, `evt:{${config.EVENT_ID}}:uholds:*`);
    if (sold !== 0 || holdKeys.length !== 0 || userHoldKeys.length !== 0) {
      throw new Error(`reset left sold=${sold}, seat-hold-keys=${holdKeys.length}, user-hold-keys=${userHoldKeys.length}`);
    }
  }
  console.log('state reset: sold=0 holds=0');
}

async function scanKeys(redis, pattern) {
  const keys = [];
  let cursor = '0';
  do {
    const [nextCursor, batch] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
    cursor = nextCursor;
    keys.push(...batch);
  } while (cursor !== '0');
  return keys;
}

async function closePools(entries) {
  await Promise.all(entries.map(({ pool }) => pool.close().catch(() => {})));
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
}

function hrtimeMs(startedAt, finishedAt = process.hrtime.bigint()) {
  return Number(finishedAt - startedAt) / 1e6;
}

module.exports = {
  ROOT,
  closePools,
  config,
  createPools,
  dispatchRequest,
  hrtimeMs,
  percentile,
  positiveInteger,
  resetEventState,
  scanKeys,
  sendRequest,
  warmPools,
};
