import React, {
  FormEvent,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ConvexError } from "convex/values";
import { LogOut } from "lucide-react";
import { setSyncAuthorized } from "../offline/runtime";

/**
 * Login gate for the real backends (offline + direct modes; mock mode never
 * mounts this). The workspace is single-user: the backend only accepts the
 * owner's account (OWNER_EMAIL on the deployment), so this screen is a lock,
 * not a multi-user login.
 *
 * Offline-first rule: a machine that has signed in before may open its local
 * replica without reaching the server — but the sync engine stays gated (see
 * setSyncAuthorized) until Convex confirms the identity, because an
 * unauthenticated outbox drain would drop queued edits.
 */

const SESSION_FLAG = "vellum:hasSession";

function hasLocalSession(): boolean {
  try {
    return localStorage.getItem(SESSION_FLAG) === "1";
  } catch {
    return false;
  }
}

function rememberSession(on: boolean): void {
  try {
    if (on) localStorage.setItem(SESSION_FLAG, "1");
    else localStorage.removeItem(SESSION_FLAG);
  } catch {
    // Storage unavailable — worst case the user sees the login screen again.
  }
}

export function AuthGate({
  client,
  children,
}: {
  client: ConvexReactClient;
  children: React.ReactNode;
}) {
  const { isLoading, isAuthenticated } = useConvexAuth();
  const wsConnected = useSyncExternalStore(
    (cb) => client.subscribeToConnectionState(() => cb()),
    () => client.connectionState().isWebSocketConnected,
  );

  useEffect(() => {
    setSyncAuthorized(isAuthenticated);
    if (isAuthenticated) rememberSession(true);
  }, [isAuthenticated]);

  if (isAuthenticated) return <>{children}</>;
  // Known owner, but the server hasn't confirmed yet (still validating the
  // stored token, or offline): open the local replica, sync gate closed.
  if (hasLocalSession() && (isLoading || !wsConnected)) return <>{children}</>;
  if (isLoading) {
    return (
      <div className="empty-state" style={{ height: "100vh" }}>
        <div className="spinner" />
      </div>
    );
  }
  return <LoginScreen />;
}

function authErrorMessage(err: unknown, flow: "signIn" | "signUp"): string {
  // Our own server-side rejections (e.g. the OWNER_EMAIL check) arrive as
  // ConvexError with a readable string; everything else gets a generic line.
  if (err instanceof ConvexError && typeof err.data === "string") {
    return err.data;
  }
  return flow === "signIn"
    ? "Sign-in failed — check the email and password."
    : "Could not create the account — passwords need 8+ characters.";
}

function LoginScreen() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const data = new FormData(e.currentTarget);
    data.set("flow", flow);
    try {
      await signIn("password", data);
      rememberSession(true);
      // Stay busy — AuthGate swaps to the app once the identity settles.
    } catch (err) {
      setError(authErrorMessage(err, flow));
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={onSubmit}>
        <div className="login-logo">📓</div>
        <h1>Vellum</h1>
        <p className="login-sub">
          {flow === "signIn"
            ? "Sign in to your workspace"
            : "Create the owner account"}
        </p>
        <input
          className="login-input"
          name="email"
          type="email"
          placeholder="Email"
          autoComplete="email"
          autoFocus
          required
        />
        <input
          className="login-input"
          name="password"
          type="password"
          placeholder="Password"
          autoComplete={flow === "signIn" ? "current-password" : "new-password"}
          minLength={8}
          required
        />
        {error && <div className="login-error">{error}</div>}
        <button className="login-submit" type="submit" disabled={busy}>
          {busy ? "Signing in…" : flow === "signIn" ? "Sign in" : "Create account"}
        </button>
        <button
          type="button"
          className="login-flip"
          onClick={() => {
            setFlow(flow === "signIn" ? "signUp" : "signIn");
            setError(null);
          }}
        >
          {flow === "signIn"
            ? "First time here? Create the owner account"
            : "Already set up? Sign in"}
        </button>
      </form>
    </div>
  );
}

/** Sidebar footer button. Only mounted in real modes (needs the provider). */
export function SignOutButton() {
  const { signOut } = useAuthActions();
  return (
    <button
      className="icon-btn"
      title="Sign out"
      onClick={() => {
        rememberSession(false);
        void signOut();
      }}
    >
      <LogOut size={15} />
    </button>
  );
}
