export function formatTime(milliseconds) {
  const seconds = Math.max(0, Math.ceil(milliseconds / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}

export function friendlyError(error) {
  const reason = error?.payload?.reason || error?.payload?.error;
  const messages = {
    HELD: 'That unit is temporarily held by someone else.',
    SOLD: 'That unit has already been confirmed.',
    NO_HOLD: 'Your hold expired. Choose an available unit to start again.',
    HOLD_LIMIT: 'You have reached the maximum number of seats you can hold at once.',
    BOOKING_ID_CONFLICT: 'This booking conflicts with an existing checkout. Release the seat and try again.',
    PAYMENT_FAILED: 'The mock payment did not complete. The hold has been released.',
    PAYMENT_IN_PROGRESS: 'Payment is still processing. Check its status before trying again.',
    EXPIRED: 'The 90-second hold expired before checkout completed.',
    FORBIDDEN: 'This checkout belongs to another guest.',
    NO_SESSION: 'The checkout session expired. Please reserve the unit again.',
    RATE_LIMITED: 'A few requests came in too quickly. Pause briefly and try again.',
    SERVICE_UNAVAILABLE: 'The inventory service is temporarily unavailable.',
    NOT_READY: 'The inventory service is recovering. Check availability and try again shortly.',
    NETWORK_ERROR: 'Cannot reach the ticketing API. Check that the backend is running.',
    INTERNAL_ERROR: 'The ticketing service encountered an error. Please check your reservation before retrying.',
    REQUEST_FAILED: 'The ticketing service could not complete that request. Please try again.'
  };
  if (messages[reason]) return messages[reason];
  if (error?.status >= 500) return messages.INTERNAL_ERROR;
  return error?.message || messages.REQUEST_FAILED;
}