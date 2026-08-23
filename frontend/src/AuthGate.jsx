import {
  SignedIn,
  SignedOut,
  SignInButton,
  SignUpButton,
  useAuth,
  useUser,
} from "@clerk/clerk-react";

/** True when a Clerk publishable key is configured. */
export const CLERK_ENABLED = Boolean(import.meta.env.VITE_CLERK_PUBLISHABLE_KEY);

// Clerk-backed auth state (only used when a ClerkProvider is mounted).
function useClerkAuthState() {
  const { isLoaded, isSignedIn, userId } = useAuth();
  return { ready: isLoaded, signedIn: Boolean(isSignedIn), userId: userId ?? null };
}

// Single-user fallback when Clerk isn't configured.
function useLocalAuthState() {
  return { ready: true, signedIn: true, userId: "local" };
}

// Best-effort display name — first name, then any name, then null.
function useClerkDisplayName() {
  const { isLoaded, isSignedIn, user } = useUser();
  if (!isLoaded || !isSignedIn || !user) return null;
  const first = (user.firstName || "").trim();
  if (first) return first;
  const full = (user.fullName || "").trim();
  if (full) return full.split(/\s+/)[0];
  const uname = (user.username || "").trim();
  return uname || null;
}

function useLocalDisplayName() {
  return null;
}

// Best-effort primary email of the signed-in user, or null.
function useClerkUserEmail() {
  const { isLoaded, isSignedIn, user } = useUser();
  if (!isLoaded || !isSignedIn || !user) return null;
  return user.primaryEmailAddress?.emailAddress || null;
}

function useLocalUserEmail() {
  return null;
}

/**
 * Auth readiness + identity, resolved ONCE at module load so the hook identity
 * is stable across renders (no conditional hook calls). Use it to gate data
 * loads until Clerk has restored the session after a page reload.
 */
export const useAuthState = CLERK_ENABLED ? useClerkAuthState : useLocalAuthState;

/** First name (or best available handle) of the signed-in user, or null. */
export const useDisplayName = CLERK_ENABLED ? useClerkDisplayName : useLocalDisplayName;

/** Primary email address of the signed-in user, or null. */
export const useUserEmail = CLERK_ENABLED ? useClerkUserEmail : useLocalUserEmail;

/**
 * Gates its children behind Clerk auth. When Clerk isn't configured it renders
 * children as-is (single-user "local" mode).
 */
export default function AuthGate({ children }) {
  if (!CLERK_ENABLED) return children;
  return (
    <>
      <SignedIn>{children}</SignedIn>
      <SignedOut>
        <section className="auth-gate card">
          <div className="auth-gate-icon">🔒</div>
          <h2>Sign in to ContentPilot</h2>
          <p>Create a free account to generate articles and keep your personal library.</p>
          <div className="auth-gate-actions">
            <SignInButton mode="modal">
              <button type="button" className="generate">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button type="button" className="ghost">
                Create account
              </button>
            </SignUpButton>
          </div>
        </section>
      </SignedOut>
    </>
  );
}
