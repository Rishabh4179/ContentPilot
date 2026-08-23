/**
 * Top-level layout: brand + primary nav + Clerk user badge, then the routed page.
 * The Outlet is wrapped in <AuthGate> so every route requires sign-in when
 * Clerk is configured (falls through as-is in local mode).
 */
import { NavLink, Outlet } from "react-router-dom";
import {
  SignedIn,
  SignedOut,
  SignInButton,
  UserButton,
} from "@clerk/clerk-react";
import AuthGate, { CLERK_ENABLED } from "./AuthGate";
import ThemeSwitcher from "./ThemeSwitcher";
import { AgentSessionProvider } from "./AgentContext";

const NAV = [
  { to: "/", label: "Generator", icon: "✨", end: true },
  { to: "/library", label: "Library", icon: "📚" },
  { to: "/dashboard", label: "Dashboard", icon: "📊" },
  { to: "/agent", label: "Agent", icon: "🤖" },
];

export default function Layout() {
  return (
    <div className="page">
      <nav className="app-nav">
        <NavLink to="/" end className="app-nav-brand">
          <span className="brand-mark">✍️</span>
          <span className="brand-name">
            Content<span className="brand-accent">Pilot</span>
          </span>
        </NavLink>
        <div className="app-nav-links">
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              className={({ isActive }) =>
                `app-nav-link${isActive ? " active" : ""}`
              }
            >
              <span aria-hidden="true">{n.icon}</span>
              <span>{n.label}</span>
            </NavLink>
          ))}
        </div>
        <div className="app-nav-user">
          <ThemeSwitcher />
          {CLERK_ENABLED && (
            <>
              <SignedIn>
                <UserButton afterSignOutUrl="/" />
              </SignedIn>
              <SignedOut>
                <SignInButton mode="modal">
                  <button type="button" className="history-toggle">
                    Sign in
                  </button>
                </SignInButton>
              </SignedOut>
            </>
          )}
        </div>
      </nav>
      <AgentSessionProvider>
        <AuthGate>
          <Outlet />
        </AuthGate>
      </AgentSessionProvider>
    </div>
  );
}
