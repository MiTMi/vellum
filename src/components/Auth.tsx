import React, {
  FormEvent,
  useEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { ConvexReactClient, useConvexAuth } from "convex/react";
import { useAuthActions } from "@convex-dev/auth/react";
import { ConvexError } from "convex/values";
import { Check, Fingerprint, LogOut } from "lucide-react";
import { setSyncAuthorized } from "../offline/runtime";
import { unmetPasswordRules, PASSWORD_RULES } from "../../convex/lib/passwordPolicy";
// The landing page's display serif, reused here so the front door carries
// the same "ink on vellum" identity as the marketing page. Bundled locally
// via @fontsource (subsetted woff2, loaded on demand) — never a CDN link.
import "@fontsource-variable/newsreader/opsz.css";
import "@fontsource-variable/newsreader/opsz-italic.css";

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
  // Our own server-side rejections (the OWNER_EMAIL check and the password
  // policy) arrive as ConvexError with a readable string; everything else
  // gets a generic line.
  if (err instanceof ConvexError && typeof err.data === "string") {
    return err.data;
  }
  return flow === "signIn"
    ? "Sign-in failed — check the email and password."
    : "Could not create the account — check the password requirements.";
}

function LoginScreen() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<"signIn" | "signUp">("signIn");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Controlled only for the live sign-up checklist; FormData still reads the
  // named inputs, so the submit path is unchanged.
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  // Touch ID (Electron on a Mac with biometrics only; undefined elsewhere).
  const [touch, setTouch] = useState<{
    available: boolean;
    enrolled: boolean;
  } | null>(null);
  const [enableTouchId, setEnableTouchId] = useState(true);

  useEffect(() => {
    let alive = true;
    void window.vellum?.touchId?.status().then((s) => {
      if (alive) setTouch(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    const data = new FormData(e.currentTarget);
    data.set("flow", flow);
    const email = String(data.get("email") ?? "");
    const password = String(data.get("password") ?? "");
    try {
      await signIn("password", data);
      rememberSession(true);
      // Only store credentials that just worked — and only with consent.
      if (touch?.available) {
        if (enableTouchId) void window.vellum?.touchId?.save(email, password);
        else void window.vellum?.touchId?.clear();
      }
      // Stay busy — AuthGate swaps to the app once the identity settles.
    } catch (err) {
      setError(authErrorMessage(err, flow));
      setBusy(false);
    }
  }

  async function onTouchId() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const creds = await window.vellum?.touchId?.signIn();
    if (!creds) {
      // Cancelled or the prompt failed — quietly fall back to the form.
      setBusy(false);
      return;
    }
    try {
      await signIn("password", { ...creds, flow: "signIn" });
      rememberSession(true);
    } catch {
      // Stored password went stale (e.g. it changed) — forget it so the
      // button doesn't keep failing, and ask for a fresh password sign-in.
      void window.vellum?.touchId?.clear();
      setTouch((t) => (t ? { ...t, enrolled: false } : t));
      setError(
        "The saved Touch ID credentials no longer work — sign in with your password to refresh them.",
      );
      setBusy(false);
    }
  }

  const signingUp = flow === "signUp";
  const unmet = unmetPasswordRules(password);
  const confirmOk = confirm === password && password.length > 0;
  const signUpBlocked = signingUp && (unmet.length > 0 || !confirmOk);

  return (
    <div className="login-screen">
      {/* Constant ink-dark brand panel — the front door wears the same
          "ink on vellum" identity as the landing page, in both themes. */}
      <aside className="login-brand" aria-hidden="true">
        <div className="login-brand-inner">
          <span className="brand-pilcrow">&para;</span>
          <span className="brand-word">Vellum</span>
          <p className="brand-tag">Write it down. Keep it forever.</p>
          <ul className="brand-points">
            <li>Private by default</li>
            <li>Offline by design</li>
            <li>Yours to keep</li>
          </ul>
        </div>
      </aside>

      <main className="login-pane">
        <form className="login-card" onSubmit={onSubmit}>
          <h1 className="login-title">
            {signingUp ? "Claim your workspace." : "Welcome back."}
          </h1>
          <p className="login-sub">
            {signingUp
              ? "Create the owner account — this workspace has exactly one."
              : "Sign in to open your workspace."}
          </p>

          {touch?.enrolled && !signingUp && (
            <>
              <button
                type="button"
                className="login-touchid"
                onClick={() => void onTouchId()}
                disabled={busy}
              >
                <Fingerprint size={16} />
                Sign in with Touch ID
              </button>
              <div className="login-divider">or use your password</div>
            </>
          )}

          <label className="login-label" htmlFor="login-email">
            Email
          </label>
          <input
            id="login-email"
            className="login-input"
            name="email"
            type="email"
            placeholder="you@example.com"
            autoComplete="email"
            autoFocus
            required
          />

          <label className="login-label" htmlFor="login-password">
            Password
          </label>
          <input
            id="login-password"
            className="login-input"
            name="password"
            type="password"
            placeholder={signingUp ? "Choose a strong passphrase" : "Password"}
            autoComplete={signingUp ? "new-password" : "current-password"}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />

          {signingUp && (
            <>
              <ul className="pw-checks">
                {PASSWORD_RULES.map((rule) => {
                  const ok = rule.test(password);
                  return (
                    <li key={rule.id} className={ok ? "ok" : ""}>
                      <span className="pw-check-box">
                        {ok && <Check size={11} strokeWidth={3} />}
                      </span>
                      {rule.label}
                    </li>
                  );
                })}
              </ul>
              <label className="login-label" htmlFor="login-confirm">
                Repeat password
              </label>
              <input
                id="login-confirm"
                className="login-input"
                type="password"
                placeholder="Same passphrase again"
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
                required
              />
              {confirm.length > 0 && !confirmOk && (
                <div className="login-error">The passwords don't match.</div>
              )}
            </>
          )}

          {touch?.available && !signingUp && (
            <label className="login-remember">
              <input
                type="checkbox"
                checked={enableTouchId}
                onChange={(e) => setEnableTouchId(e.target.checked)}
              />
              Enable Touch ID sign-in on this Mac
            </label>
          )}
          {error && <div className="login-error">{error}</div>}

          <button
            className="login-submit"
            type="submit"
            disabled={busy || signUpBlocked}
          >
            {busy ? "Signing in…" : signingUp ? "Create account" : "Sign in"}
          </button>
          <button
            type="button"
            className="login-flip"
            onClick={() => {
              setFlow(signingUp ? "signIn" : "signUp");
              setError(null);
              setPassword("");
              setConfirm("");
            }}
          >
            {signingUp
              ? "Already set up? Sign in"
              : "First time here? Create the owner account"}
          </button>
        </form>
      </main>
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
