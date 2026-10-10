// Rebuild Redis sold state from durable Postgres rows before the API accepts reservations.
'use strict';

const config = require('./config');
const { redis } = require('./redis');
const { pool } = require('./pg');

async function rehydrate() {
  try {
    const { rows } = await pool.query(
      'SELECT unit_id, booking_id FROM bookings WHERE event_id = $1',
      [config.EVENT_ID],
    );
    const pipeline = redis.pipeline();
    for (const row of rows) {
      pipeline.hsetnx(config.soldKey(), String(row.unit_id), row.booking_id);
    }
    const results = await pipeline.exec();
    let restored = 0;
    for (const [error, added] of results) {
      if (error) throw error;
      if (added === 1) restored += 1;
    }
    await redis.set(config.readyKey(), '1');
    console.log(`[rehydrate] event ${config.EVENT_ID}: ${rows.length} sold seats in Postgres, ${restored} restored into Redis, ready sentinel set`);
    return restored;
  } catch (error) {
    await redis.del(config.readyKey()).catch(() => {});
    throw error;
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let activeLoop = null;
let rerunRequested = false;

function rehydrateWithRetry({ baseDelayMs = 200, maxDelayMs = 5000, shouldStop = () => false, tag = '[rehydrate]' } = {}) {
  if (activeLoop) {
    rerunRequested = true;
    redis.del(config.readyKey()).catch(() => {});
    return activeLoop;
  }
  activeLoop = (async () => {
    try {
      do {
        rerunRequested = false;
        await redis.del(config.readyKey()).catch(() => {});
        let attempt = 0;
        for (;;) {
          if (shouldStop()) return;
          try {
            await rehydrate();
            break;
          } catch (error) {
            if (shouldStop()) return;
            const delay = Math.min(baseDelayMs * (2 ** attempt), maxDelayMs);
            attempt += 1;
            console.error(`${tag} rehydrate after reconnect failed: ${error.message} (retrying in ${delay} ms)`);
            await sleep(delay);
          }
        }
      } while (rerunRequested && !shouldStop());
    } finally {
      activeLoop = null;
    }
  })();
  return activeLoop;
}

rehydrate.rehydrateWithRetry = rehydrateWithRetry;
module.exports = rehydrate;