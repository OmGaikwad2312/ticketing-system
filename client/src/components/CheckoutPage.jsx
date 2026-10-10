import { useState } from 'react';
import { ArrowLeft, Check, CreditCard, LockKeyhole, LoaderCircle, ShieldCheck, Ticket } from 'lucide-react';
import { formatTime } from '../lib/presentation.js';

const PAYMENT_OPTIONS = [
  { id: 'visa', label: 'VISA CREDIT', type: 'Visa credit card', number: '4242 4242 4242 4242', cvc: '123' },
  { id: 'mastercard', label: 'MASTERCARD', type: 'Mastercard credit card', number: '5555 5555 5555 4444', cvc: '123' },
  { id: 'debit', label: 'DEBIT CARD', type: 'Debit card', number: '4000 0000 0000 0002', cvc: '123' },
  { id: 'amex', label: 'AMEX', type: 'American Express credit card', number: '3782 822463 10005', cvc: '1234' }
];

function CheckoutPage({ busy, holds, nextExpiry, now, onBack, onPayAndConfirm }) {
  const [completion, setCompletion] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [selectedPayment, setSelectedPayment] = useState('visa');
  const [cardDetails, setCardDetails] = useState({ number: '', expiry: '', cvc: '', zip: '' });

  const submit = async (event) => {
    event.preventDefault();
    if (submitting || busy !== '') return;
    setSubmitting(true);
    try {
      const result = await onPayAndConfirm();
      if (result?.allConfirmed) {
        setCompletion(result.confirmedUnits);
      } else {
        setCompletion({
          pendingUnits: result?.pendingUnits || [],
          failures: result?.failures || []
        });
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (Array.isArray(completion)) {
    return (
      <section className="checkout-page checkout-complete" aria-live="polite">
        <span className="checkout-success-icon"><Check size={25} /></span>
        <p className="eyebrow">DEMO PAYMENT COMPLETE</p>
        <h1>Your seats are confirmed.</h1>
        <p className="checkout-intro">This mock purchase did not charge a card. Your booking was confirmed by the reservation service.</p>
        <div className="confirmation-tickets">
          {completion.map((unit) => (
            <div className="confirmation-ticket" key={unit}>
              <Ticket size={17} />
              <span>Unit {unit}</span>
              <strong>CONFIRMED</strong>
            </div>
          ))}
        </div>
        <button className="checkout-back-button" onClick={onBack} type="button">
          <ArrowLeft size={16} /> Return to seat map
        </button>
      </section>
    );
  }

  const pendingUnits = completion?.pendingUnits || [];
  const failures = completion?.failures || [];
  const subtotal = holds.length * 129;
  const serviceFee = holds.length ? 18 : 0;
  const holdTime = Number.isFinite(nextExpiry) ? formatTime(nextExpiry - now) : '—:—';
  const activePayment = PAYMENT_OPTIONS.find((option) => option.id === selectedPayment);

  return (
    <section className="checkout-page" aria-labelledby="checkout-title">
      <div className="checkout-page-heading">
        <button className="checkout-back-link" onClick={onBack} type="button">
          <ArrowLeft size={15} /> Back to seats
        </button>
        <div className="checkout-progress" aria-label="Checkout step 2 of 2">
          <span className="checkout-progress-done"><Check size={12} /> Seats</span>
          <span className="checkout-progress-line" />
          <span className="checkout-progress-current">Payment</span>
        </div>
      </div>

      <div className="checkout-layout">
        <div className="checkout-main">
          <div className="checkout-title-row">
            <div>
              <p className="eyebrow">SECURE DEMO CHECKOUT</p>
              <h1 id="checkout-title">Checkout</h1>
              <p className="checkout-intro">Guest checkout <span>·</span> No account required</p>
            </div>
          </div>

          <form className="demo-payment-form" onSubmit={submit}>
            <h2 className="checkout-form-section-title">Guest information</h2>
            <label className="demo-field">
              <span>Full name</span>
              <input autoComplete="off" name="guest-name" />
            </label>
            <label className="demo-field">
              <span>Email</span>
              <input autoComplete="off" name="guest-email" type="email" />
            </label>

            <h2 className="checkout-form-section-title checkout-payment-title">Payment</h2>
            <div className="payment-method-heading">
              <CreditCard size={21} />
            </div>
            <div className="card-brands" role="tablist" aria-label="Demo payment types">
              {PAYMENT_OPTIONS.map((option) => (
                <button
                  aria-selected={selectedPayment === option.id}
                  className={`card-brand${selectedPayment === option.id ? ' selected' : ''}`}
                  key={option.id}
                  onClick={() => {
                    setSelectedPayment(option.id);
                    setCardDetails({
                      number: option.number,
                      expiry: '12/29',
                      cvc: option.cvc,
                      zip: '94107'
                    });
                  }}
                  role="tab"
                  type="button"
                >
                  {option.label}
                </button>
              ))}
            </div>
            <label className="demo-field">
              <span>Card number</span>
              <input
                autoComplete="off"
                inputMode="numeric"
                maxLength={19}
                name="number"
                onChange={(event) => setCardDetails((current) => ({ ...current, number: event.target.value }))}
                value={cardDetails.number}
              />
            </label>
            <div className="demo-field-row">
              <label className="demo-field">
                <span>Expiry date</span>
                <input
                  autoComplete="off"
                  maxLength={7}
                  name="expiry"
                  onChange={(event) => setCardDetails((current) => ({ ...current, expiry: event.target.value }))}
                  value={cardDetails.expiry}
                />
              </label>
              <label className="demo-field">
                <span>Security code</span>
                <input
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={4}
                  name="cvc"
                  onChange={(event) => setCardDetails((current) => ({ ...current, cvc: event.target.value }))}
                  value={cardDetails.cvc}
                />
              </label>
              <label className="demo-field">
                <span>Billing ZIP code</span>
                <input
                  autoComplete="off"
                  inputMode="numeric"
                  maxLength={10}
                  name="zip"
                  onChange={(event) => setCardDetails((current) => ({ ...current, zip: event.target.value }))}
                  value={cardDetails.zip}
                />
              </label>
            </div>

            <div className="promo-code-row">
              <label className="demo-field">
                <span>Promotional code (optional)</span>
                <input autoComplete="off" name="promo" />
              </label>
            </div>

            <div className="demo-card-callout">
              <ShieldCheck size={16} />
              <p><strong>Demo only.</strong> {activePayment.type}: <b>{activePayment.number}</b>, expiry <b>12/29</b>, security code <b>123</b>, ZIP <b>94107</b>. Enter these only if you want to test the form. Switching card types does not fill the fields. Do not use a real card; nothing is charged or sent to the backend.</p>
            </div>

            {completion && (
              <div className="checkout-result-message" role="status">
                {pendingUnits.length > 0 && <p>Payment status is still processing for units {pendingUnits.join(', ')}. You can safely check again.</p>}
                {failures.map((failure) => <p key={failure}>{failure}</p>)}
                {pendingUnits.length === 0 && failures.length === 0 && <p>Payment could not be confirmed. Check the reservation status or return to the seat map.</p>}
              </div>
            )}

            <button className="checkout-pay-button" disabled={submitting || busy !== '' || holds.length === 0} type="submit">
              {submitting || busy === 'payment'
                ? <LoaderCircle className="spin" size={17} />
                : <LockKeyhole size={16} />}
              {pendingUnits.length > 0 ? 'Retry payment' : 'Confirm booking'}
            </button>
            <p className="checkout-security-caption"><LockKeyhole size={12} /> Secure seat confirmation <span>·</span> No real charge</p>
          </form>
        </div>

        <aside className="checkout-order-card" aria-label="Booking summary">
          <p className="eyebrow">YOUR ORDER</p>
          <div className="checkout-order-heading">
            <div><h2>Order summary</h2><span>{holds.length} {holds.length === 1 ? 'seat' : 'seats'}</span></div>
            <strong className="checkout-hold-time">{holdTime}</strong>
          </div>
          <div className="checkout-order-list">
            {holds.map((hold) => (
              <div className="checkout-order-item" key={hold.bookingId}>
                <span className="checkout-order-icon"><Ticket size={15} /></span>
                <span><strong>Unit {hold.unit}</strong><small>{hold.phase === 'pending' ? 'Payment processing' : 'Reserved for you'}</small></span>
                <strong className="checkout-demo-price">₹129</strong>
              </div>
            ))}
            {holds.length === 0 && (
              <p className="checkout-no-seats">No active seats remain. Return to the seat map to make a new reservation.</p>
            )}
          </div>
          {holds.length > 0 && (
            <div className="checkout-price-breakdown">
              <div><span>Subtotal</span><strong>₹{subtotal}</strong></div>
              <div><span>Service fee</span><strong>₹{serviceFee}</strong></div>
            </div>
          )}
          <div className="checkout-total-row"><span>Total <small>demo amount</small></span><strong>₹{subtotal + serviceFee}</strong></div>
          <p className="checkout-price-disclaimer">Sample pricing only. No actual payment is collected.</p>
          <div className="checkout-order-note"><ShieldCheck size={14} /> Seat availability is secured by the live reservation service.</div>
        </aside>
      </div>
    </section>
  );
}

export default CheckoutPage;
