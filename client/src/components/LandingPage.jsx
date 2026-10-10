import { useLayoutEffect, useRef } from 'react';
import { ArrowDown, ArrowRight, Armchair, Moon, Sun, Ticket, Timer, WalletCards } from 'lucide-react';
import { gsap } from 'gsap';
import { ScrollTrigger } from 'gsap/ScrollTrigger';
import useTheme from '../hooks/useTheme.js';
import './LandingPage.css';

gsap.registerPlugin(ScrollTrigger);

const BOOKING_STEPS = [
  {
    number: '01',
    title: 'Choose your seat',
    description: 'Browse the live seat map. Availability updates as seats are held and confirmed.',
    Icon: Armchair
  },
  {
    number: '02',
    title: 'Move before time runs out',
    description: 'A selected seat is held for 90 seconds, giving you time to complete checkout.',
    Icon: Timer
  },
  {
    number: '03',
    title: 'Confirm your booking',
    description: 'Review your reservation and finish checkout before your hold expires.',
    Icon: WalletCards
  }
];

function LandingPage() {
  const pageRef = useRef(null);
  const { darkTheme, toggleTheme } = useTheme();

  useLayoutEffect(() => {
    const page = pageRef.current;
    if (!page || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;

    const context = gsap.context(() => {
      gsap.timeline({ defaults: { ease: 'power3.out' } })
        .from('.landing-header', { y: -18, opacity: 0, duration: 0.65 })
        .from('.landing-eyebrow', { y: 14, opacity: 0, duration: 0.45 }, '-=0.22')
        .from('.landing-title', { y: 28, opacity: 0, duration: 0.75 }, '-=0.18')
        .from('.landing-subtitle, .landing-copy', { y: 16, opacity: 0, duration: 0.55, stagger: 0.12 }, '-=0.35')
        .from('.landing-cta, .landing-event-note', { y: 12, opacity: 0, duration: 0.5, stagger: 0.12 }, '-=0.25');

      gsap.to('.landing-dot-trail', {
        y: -9,
        duration: 2.8,
        repeat: -1,
        yoyo: true,
        ease: 'sine.inOut'
      });

      gsap.from('.landing-step', {
        y: 24,
        opacity: 0,
        duration: 0.65,
        stagger: 0.14,
        ease: 'power2.out',
        scrollTrigger: {
          trigger: '.landing-steps',
          start: 'top 82%',
          once: true
        }
      });
    }, page);

    return () => context.revert();
  }, []);

  return (
    <main ref={pageRef} className="landing-page" data-theme={darkTheme ? 'dark' : 'light'}>
      <header className="landing-header">
        <a className="landing-brand" href="/" aria-label="Flash Pass home">
          <span className="landing-brand-icon"><Ticket size={17} /></span>
          <span>FLASH<span className="landing-brand-slash">//</span>PASS</span>
        </a>
        <div className="landing-event-status">
          <span>LIVE EVENT</span>
          <i aria-hidden="true" />
          <span>Seat reservations open</span>
        </div>
        <button
          className="landing-theme-toggle"
          type="button"
          onClick={toggleTheme}
          aria-label={`Switch to ${darkTheme ? 'light' : 'dark'} theme`}
        >
          <span>Theme</span>
          {darkTheme ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </header>

      <section className="landing-hero" aria-labelledby="landing-title">
        <div className="landing-art" aria-hidden="true">
          <svg className="landing-orbits" viewBox="0 0 1440 700" preserveAspectRatio="none">
            <path d="M-120 285C230 75 670 74 1560 164" />
            <path d="M-120 323C250 127 710 119 1560 208" />
            <path d="M-140 395C270 270 600 270 1570 464" />
            <path d="M-130 438C250 321 650 338 1570 514" />
            <path d="M-100 500C270 492 760 630 1540 568" />
          </svg>
          <div className="landing-dot-trail landing-dot-trail-top" />
          <div className="landing-dot-trail landing-dot-trail-bottom" />
          <div className="landing-ticket-shape" />
        </div>

        <div className="landing-hero-content">
          <p className="landing-eyebrow">FLASH RESERVATION <span>/</span> LIVE EVENT</p>
          <h1 className="landing-title" id="landing-title">One seat.One Winner</h1>
          <p className="landing-subtitle">A fairer way into the room.</p>
          <p className="landing-copy">Join the queue, choose your view, and book without the rush.</p>
          <a className="landing-cta" href="/booking">
            <Ticket size={15} />
            <span>Book Your Seat</span>
            <ArrowRight className="landing-cta-arrow" size={16} />
          </a>
          <p className="landing-event-note">Live seat inventory <span>·</span> Guest checkout</p>
        </div>
        <a className="landing-scroll-cue" href="#booking-guide" aria-label="Read booking instructions">
          <ArrowDown size={16} />
        </a>
      </section>

      <section className="landing-guide" id="booking-guide" aria-labelledby="booking-guide-title">
        <div className="landing-guide-heading">
          <p className="landing-eyebrow">THREE SIMPLE STEPS</p>
          <h2 id="booking-guide-title">A smoother way to your seat.</h2>
          <p>Know what to expect before you enter the live seat map.</p>
        </div>
        <div className="landing-steps">
          {BOOKING_STEPS.map(({ number, title, description, Icon }) => (
            <article className="landing-step" key={number}>
              <div className="landing-step-top">
                <span className="landing-step-number">{number}</span>
                <span className="landing-step-icon"><Icon size={19} /></span>
              </div>
              <h3>{title}</h3>
              <p>{description}</p>
            </article>
          ))}
        </div>
        <a className="landing-guide-cta" href="/booking">
          Start booking <ArrowRight size={15} />
        </a>
      </section>
      <footer className="landing-footer">FLASH//PASS <span>Live inventory · Secure reservations</span></footer>
    </main>
  );
}

export default LandingPage;
