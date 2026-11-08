import { Link, NavLink, Outlet, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';
import { ArrowRight } from './Glyph';

const links = [
  { to: '/grid', label: 'The Grid' },
  { to: '/investigations', label: 'Investigations' },
  { to: '/afterlife', label: 'The Afterlife' },
  { to: '/activity', label: 'Activity' },
  { to: '/remediation', label: 'Remediation' },
];

export function Layout() {
  const location = useLocation();
  return (
    <div className="app-shell">
      <nav className="sidebar" aria-label="Primary">
        <Link to="/" className="brand sidebar-brand">
          Credential Reaper
          <span className="brand-sub">MACHINE IDENTITY</span>
        </Link>
        <div className="sidebar-nav">
          <NavLink to="/" end className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
            Overview
          </NavLink>
          {links.map((link) => (
            <NavLink key={link.to} to={link.to} className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}>
              {link.label}
            </NavLink>
          ))}
        </div>
        <div className="sidebar-foot">No credentials touched</div>
      </nav>
      <main className="main">
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}

/** Full-bleed shell for the landing page: its own top bar, no sidebar. */
export function LandingLayout() {
  const location = useLocation();
  return (
    <div className="landing">
      <header className="topbar">
        <Link to="/" className="brand topbar-brand">
          Credential Reaper
        </Link>
        <span className="topbar-sub">MACHINE IDENTITY</span>
        <nav className="topbar-nav" aria-label="Primary">
          {links
            .filter((link) => link.to !== '/grid')
            .map((link) => (
              <NavLink key={link.to} to={link.to} className={({ isActive }) => `topbar-link${isActive ? ' active' : ''}`}>
                {link.label}
              </NavLink>
            ))}
        </nav>
        <Link to="/grid" className="btn btn-sm topbar-cta">
          Open the grid <ArrowRight />
        </Link>
      </header>
      <ErrorBoundary key={location.pathname}>
        <Outlet />
      </ErrorBoundary>
    </div>
  );
}
