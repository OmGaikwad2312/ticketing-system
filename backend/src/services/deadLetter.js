// Idempotent terminal-job handler: record the failure, restore Postgres seat truth, and refund the loser.
'use strict';

const config = require('../config');
const { redis } = require('../redis');
const { pool } = require('../pg');

async function deadLetter(job, error, db = pool) {
  const { bookingId, unit, userId, eventId } = job.data;
  const payload = { bookingId, unit, userId, eventId, jobId: job.id };
  const reason = error?.message || String(error);

  const inserted = await db.query(
    `INSERT INTO dead_letters (payload, reason, status)
     VALUES ($1, $2, 'PENDING')
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [JSON.stringify(payload), reason],
  );
  let deadLetterId = inserted.rows[0]?.id;
  if (deadLetterId === undefined) {
    const existing = await db.query("SELECT id FROM dead_letters WHERE payload->>'bookingId' = $1", [bookingId]);
    deadLetterId = existing.rows[0]?.id;
  }

  const winner = await db.query(
    'SELECT booking_id::text FROM bookings WHERE event_id = $1 AND unit_id = $2',
    [eventId, Number(unit)],
  );
  if (winner.rows[0]) {
    await redis.hset(config.soldKey(), String(unit), winner.rows[0].booking_id);
    if (deadLetterId !== undefined) {
      await db.query(
        "UPDATE dead_letters SET status = 'RESOLVED', resolved_at = now() WHERE id = $1",
        [deadLetterId],
      );
    }
  }

  const paymentKey = config.payKey(bookingId);
  if (await redis.exists(paymentKey)) {
    await redis.pay_finish(paymentKey, 'REFUND', String(config.PAID_SESSION_TTL_MS), '');
  }
  await redis.del(config.bookingKey(bookingId));

  try {
    const seq = await redis.incr(config.seqKey());
    await redis.publish(config.channel, JSON.stringify({ unit: Number(unit), state: 'sold', seq: Number(seq) }));
  } catch (_) {
    /* Pub/Sub is best-effort and cannot block dead-letter reconciliation. */
  }

  console.error(`[DEAD-LETTER] booking=${bookingId} unit=${unit} winner=${winner.rows[0]?.booking_id || 'unknown'} reason=${reason}`);
}

module.exports = { deadLetter };