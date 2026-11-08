import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { ErrorBoundary } from './ErrorBoundary';

const links = [
  { to: '/', label: 'The Grid' },
  { to: '/investigations', label: 'Investigations' },
  { to: '/afterlife', label: 'The Afterlife' },
  { to: '/remediation', label: 'Remediation' },
];

export function Layout() {
  const location = useLocation();
  return (
    <div className="app-shell">
      <nav className="sidebar">
        <div className="sidebar-brand">
          <span className="skull">☠</span> Credential Reaper
        </div>
        {links.map((link) => (
          <NavLink
            key={link.to}
            to={link.to}
            className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
            end={link.to === '/'}
          >
            {link.label}
          </NavLink>
        ))}
      </nav>
      <main className="main">
        <ErrorBoundary key={location.pathname}>
          <Outlet />
        </ErrorBoundary>
      </main>
    </div>
  );
}
