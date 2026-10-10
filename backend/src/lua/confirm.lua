-- Read the existing sale for this unit so retries are idempotent.
local sold = redis.call('HGET', KEYS[1], ARGV[1])
-- If this booking already owns the sale, report success without replacing its durable record.
if sold then
  -- Return success for a retry of the same booking identifier.
  if sold == ARGV[3] then return 'OK' end
  -- Refuse a different booking because the unit is already sold.
  return 'SOLD'
end
-- Read the temporary hold value, which can contain userId or userId|bookingId.
local holder = redis.call('GET', KEYS[2])
-- A missing hold means the reservation expired or was released.
if not holder then return 'EXPIRED' end
-- Find the separator in a booking-bound hold value.
local sep = string.find(holder, '|', 1, true)
-- Extract the hold owner's user ID from either supported hold format.
local holderUser = sep and string.sub(holder, 1, sep - 1) or holder
-- Extract the optional booking ID that is bound to this hold.
local holderBooking = sep and string.sub(holder, sep + 1) or ''
-- Refuse confirmation unless both the user and any bound booking ID match.
if holderUser ~= ARGV[2] or (holderBooking ~= '' and holderBooking ~= ARGV[3]) then return 'EXPIRED' end
-- Remove the temporary hold after verifying its owner.
redis.call('DEL', KEYS[2])
-- Record the permanent unit-to-booking mapping.
redis.call('HSET', KEYS[1], ARGV[1], ARGV[3])
-- Read Redis server time so confirmation age uses the Redis clock.
local t = redis.call('TIME')
-- Convert Redis seconds and microseconds into epoch milliseconds.
local nowMs = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
-- Write the durable booking handoff record in the same atomic script as the sale.
redis.call('HSET', KEYS[3], 'unit', ARGV[1], 'user', ARGV[2], 'bookingId', ARGV[3], 'event', ARGV[4], 'confirmedAt', nowMs)
-- Keep the handoff record available long enough for workers and the recovery sweeper.
redis.call('PEXPIRE', KEYS[3], tonumber(ARGV[5]))
-- Report that the booking and durable handoff record were committed atomically.
return 'OK'