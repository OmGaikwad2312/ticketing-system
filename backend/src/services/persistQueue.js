// BullMQ producer for confirmed bookings. Redis booking records remain the durable source of truth.
'use strict';

const { Queue } = require('bullmq');
const config = require('../config');
const { createBullConnection, waitUntilReady } = require('../redis');

let queuePromise = null;
let producerConnection = null;

async function getQueue() {
  if (!queuePromise) {
    queuePromise = (async () => {
      producerConnection = createBullConnection('producer');
      try {
        await waitUntilReady(producerConnection);
        await producerConnection.ping();
        const queue = new Queue(config.PERSIST_QUEUE_NAME, {
          connection: producerConnection,
          prefix: config.BULL_PREFIX,
        });
        await queue.waitUntilReady();
        return queue;
      } catch (error) {
        producerConnection.disconnect();
        producerConnection = null;
        throw error;
      }
    })().catch((error) => {
      queuePromise = null;
      throw error;
    });
  }
  return queuePromise;
}

async function enqueueBooking({ bookingId, unit, userId, eventId }, { replaceTerminalJob = false } = {}) {
  const queue = await getQueue();
  if (replaceTerminalJob) {
    const existing = await queue.getJob(bookingId);
    if (existing) {
      const state = await existing.getState();
      if (state === 'failed' || state === 'completed') {
        await existing.remove().catch(() => {});
      }
    }
  }
  return queue.add('persist', { bookingId, unit, userId, eventId }, {
    jobId: bookingId,
    attempts: config.JOB_ATTEMPTS,
    backoff: { type: 'capped' },
    removeOnComplete: { age: 3600, count: 1000 },
    removeOnFail: { age: 7 * 24 * 3600 },
  });
}

async function getCounts() {
  const queue = await getQueue();
  return queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed', 'prioritized');
}

async function closeQueue() {
  const pending = queuePromise;
  queuePromise = null;
  if (pending) {
    try {
      const queue = await pending;
      await queue.close();
    } catch (_) {
      /* A failed lazy connection has already been disconnected. */
    }
  }
  if (producerConnection) {
    await producerConnection.quit().catch(() => producerConnection.disconnect());
    producerConnection = null;
  }
}

module.exports = { enqueueBooking, getQueue, getCounts, closeQueue };