import { Moon, Sun, Ticket } from 'lucide-react';

function TopBar({ holdCount, darkTheme, onToggleTheme }) {
  return (
    <header className="topbar">
      <a className="wordmark" href="#top" aria-label="Ticketing home">
        <span className="mark"><Ticket size={15} strokeWidth={2.5} /></span>
        <span>LIVE<span className="wordmark-divider"> / </span>INVENTORY</span>
      </a>
      <nav className="topnav" aria-label="Main navigation">
        <a className="nav-link active" href="#inventory">Seat map</a>
        <a className="nav-link" href="#reservation">Reservation <span className="nav-count">{holdCount}</span></a>
      </nav>
      <div className="topbar-meta">
        <span className="live-caption"><span className="live-dot" /> LIVE INVENTORY</span>
        <span className="guest-chip">Guest checkout</span>
        <button
          className="theme-toggle"
          type="button"
          onClick={onToggleTheme}
          aria-label={`Switch to ${darkTheme ? 'light' : 'dark'} theme`}
          title={`Switch to ${darkTheme ? 'light' : 'dark'} theme`}
        >
          {darkTheme ? <Sun size={15} /> : <Moon size={15} />}
        </button>
      </div>
    </header>
  );
}

export default TopBar;