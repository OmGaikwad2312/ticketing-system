// Mock payment gateway (no real money). A payment "session" is a Redis hash pay:<bookingId>
// {user, unit, status, lock, paidAt} with a TTL. `pay()` uses atomic begin_payment / finish_payment
// scripts to verify hold ownership, prevent double charges, and eliminate mid-charge session expiration.
'use strict';

const config = require('../config');
const { redis } = require('../redis');
const { confirmSeat, releaseSeat } = require('./inventory');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Default mock payment gateway. Carries `idempotencyKey` (bookingId) in the interface.
 */
async function defaultGateway({ idempotencyKey: _idempotencyKey }) {
  await sleep(config.PAYMENT_DELAY_MS);
  return Math.random() >= config.PAYMENT_FAIL_RATE;
}

let gateway = defaultGateway;

/** Inject a custom payment gateway function (used by tests). */
function setGateway(fn) {
  gateway = fn || defaultGateway;
}

/** Read a session hash; returns null when it does not exist (never created or expired). */
async function getSession(bookingId) {
  const session = await redis.hgetall(config.payKey(bookingId));
  return session && session.status ? session : null;
}

/** Guarded status update (e.g. 'REFUND') via pay_finish.lua; never recreates an expired key. */
async function setStatus(bookingId, status) {
  const ttlMs = status === 'PAID' || status === 'REFUND' ? config.PAID_SESSION_TTL_MS : config.PAY_SESSION_TTL_MS;
  const updated = await redis.pay_finish(config.payKey(bookingId), status, String(ttlMs), '');
  if (Number(updated) === 0) {
    console.error(`[payment] ALERT: session ${bookingId} vanished before status update to ${status}`);
  }
  return Number(updated) === 1;
}

/**
 * Create a PENDING payment session for a seat the user currently holds.
 * Returns { status, unit, user, bookingId } or { error: 'NO_HOLD' | 'BOOKING_ID_CONFLICT' }.
 * Idempotent: calling it again with the same bookingId returns the existing session.
 */
async function createSession(userId, unit, bookingId) {
  const holderVal = await redis.get(config.holdKey(unit));
  if (!holderVal) return { error: 'NO_HOLD' };

  const sep = holderVal.indexOf('|');
  const holderUser = sep !== -1 ? holderVal.slice(0, sep) : holderVal;
  if (holderUser !== userId) return { error: 'NO_HOLD' };

  const key = config.payKey(bookingId);
  const existing = await getSession(bookingId);
  if (existing) {
    if (existing.user === userId && Number(existing.unit) === Number(unit)) {
      return { status: existing.status, unit: Number(unit), user: userId, bookingId };
    }
    return { error: 'BOOKING_ID_CONFLICT' };
  }

  // HSET + PEXPIRE in one MULTI so the session can never exist without a TTL.
  await redis.multi()
    .hset(key, { user: userId, unit: String(unit), status: 'PENDING' })
    .pexpire(key, config.PAY_SESSION_TTL_MS)
    .exec();

  return { status: 'PENDING', unit: Number(unit), user: userId, bookingId };
}

/**
 * Charge a session only after Redis atomically verifies the user, seat hold, and payment lock.
 * `decided` is true only for the caller that invoked the gateway.
 */
async function pay(bookingId, callerUserId) {
  const key = config.payKey(bookingId);
  const session = await getSession(bookingId);
  if (!session) return { status: 'NO_SESSION', decided: false };

  const unit = Number(session.unit);
  const effectiveUser = callerUserId === undefined ? session.user : callerUserId;
  const begin = await redis.pay_begin(
    config.soldKey(),
    config.holdKey(unit),
    key,
    String(unit),
    String(effectiveUser),
    String(config.PAYMENT_TIMEOUT_MS),
    String(config.PAYMENT_TIMEOUT_MS),
  );
  const code = Array.isArray(begin) ? begin[0] : begin;

  if (code === 'NO_SESSION') return { status: 'NO_SESSION', decided: false };
  if (code === 'FORBIDDEN') return { status: 'FORBIDDEN', user: session.user, unit, decided: false };
  if (code === 'DUP') {
    return {
      status: begin[1] || session.status,
      user: session.user,
      unit,
      decided: false,
    };
  }
  if (code === 'SOLD' || code === 'EXPIRED') {
    return { status: code, user: session.user, unit, decided: false };
  }
  if (code !== 'GO') {
    throw new Error(`Unexpected pay_begin result for ${bookingId}: ${JSON.stringify(begin)}`);
  }

  const success = await gateway({
    idempotencyKey: bookingId,
    bookingId,
    user: session.user,
    unit,
  });

  if (success) {
    const finished = await redis.pay_finish(
      key,
      'PAID',
      String(config.PAID_SESSION_TTL_MS),
      String(Date.now()),
    );
    if (Number(finished) === 0) {
      console.error(`[payment] ALERT: session ${bookingId} vanished during payment charge for user=${session.user} unit=${unit}; proceeding with confirm`);
    }
    return { status: 'PAID', user: session.user, unit, decided: true };
  }

  const finished = await redis.pay_finish(key, 'FAILED', String(config.PAY_SESSION_TTL_MS), '');
  if (Number(finished) === 0) {
    console.error(`[payment] ALERT: session ${bookingId} vanished during failed payment charge for user=${session.user} unit=${unit}`);
  }
  return { status: 'FAILED', user: session.user, unit, decided: true };
}

/**
 * Run payment and apply its result to inventory.
 * Returns BOOKED, SOLD, EXPIRED, PAYMENT_FAILED, PENDING, NO_SESSION, FORBIDDEN, or NOT_READY.
 */
async function settle(userId, bookingId) {
  const result = await pay(bookingId, userId);
  if (result.status === 'NO_SESSION') return { outcome: 'NO_SESSION', bookingId };
  if (result.status === 'FORBIDDEN' || result.user !== userId) {
    return { outcome: 'FORBIDDEN', bookingId };
  }

  const unit = Number(result.unit);
  if (result.status === 'SOLD') return { outcome: 'SOLD', unit, bookingId };
  if (result.status === 'EXPIRED') return { outcome: 'EXPIRED', unit, bookingId };

  if (result.status === 'PAID') {
    const confirmed = await confirmSeat(unit, userId, bookingId);
    if (confirmed === 'OK') return { outcome: 'BOOKED', unit, bookingId };
    if (confirmed === 'NOT_READY') return { outcome: 'NOT_READY', unit, bookingId };

    await setStatus(bookingId, 'REFUND');
    return { outcome: confirmed === 'SOLD' ? 'SOLD' : 'EXPIRED', unit, bookingId };
  }

  if (result.status === 'FAILED') {
    if (result.decided) await releaseSeat(unit, userId);
    return { outcome: 'PAYMENT_FAILED', unit, bookingId };
  }

  if (result.status === 'REFUND') return { outcome: 'EXPIRED', unit, bookingId };
  return { outcome: 'PENDING', unit, bookingId };
}

module.exports = { createSession, pay, settle, getSession, setStatus, setGateway };
