'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { config, redis, pool, cleanRedis } = require('./helpers');
const { getCounts } = require('../src/services/persistQueue');
const calcSlot = require('cluster-key-slot');

function crc16(buffer) {
  let crc = 0;
  for (let index = 0; index < buffer.length; index += 1) {
    crc ^= buffer[index] << 8;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

function manualSlot(key) {
  const value = String(key);
  const open = value.indexOf('{');
  const close = value.indexOf('}', open + 1);
  const tagged = open !== -1 && close > open + 1 ? value.slice(open + 1, close) : value;
  return crc16(Buffer.from(tagged)) % 16384;
}

describe('Step 6a: Redis Cluster hash-tag alignment and BullMQ persistence', () => {
  before(async () => {
    const schema = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
    await pool.query(schema);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM bookings WHERE event_id = $1', [config.EVENT_ID]);
    await cleanRedis();
  });

  after(async () => {
    await pool.query('DELETE FROM bookings WHERE event_id = $1', [config.EVENT_ID]).catch(() => {});
  });

  it('keeps Lua keys, booking records, and BullMQ keys in the event hash slot', () => {
    const bookingId = crypto.randomUUID();
    const keys = [
      config.soldKey(),
      config.holdKey(7),
      config.readyKey(),
      config.userHoldsKey('alice'),
      config.holdMaxKey(7),
      config.bookingKey(bookingId),
      config.payKey(bookingId),
      config.BULL_PREFIX,
    ];
    const expected = calcSlot(config.soldKey());
    for (const key of keys) {
      assert.equal(calcSlot(key), expected, `${key} must share the event slot`);
      assert.equal(manualSlot(key), expected, `${key} manual slot must share the event slot`);
    }
  });

  it('provides BullMQ queue counts without a custom booking stream', async () => {
    const counts = await getCounts();
    assert.equal(Number(counts.waiting || 0), 0);
    assert.equal(await redis.exists(config.bookingKey('missing')), 0);
  });
});