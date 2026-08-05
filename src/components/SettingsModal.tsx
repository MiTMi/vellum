import React, { useEffect, useState } from "react";
import {
  AlertTriangle,
  Check,
  Fingerprint,
  Lock,
  LockOpen,
  LogOut,
  Moon,
  Settings as SettingsIcon,
  Sun,
  X,
} from "lucide-react";
import { useAuthActions } from "@convex-dev/auth/react";
import Modal from "./ui/Modal";
import { IS_MOCK, useAccount } from "../data";
import { useNav } from "../state";
import { PASSWORD_RULES, unmetPasswordRules } from "../../convex/lib/passwordPolicy";
import {
  isVaultUnlocked,
  lockVault,
  useVaultVersion,
  vaultRootId,
} from "../lib/vaultSession";

/**
 * App settings. One modal, four sections: Account (change password),
 * Security (sessions, Touch ID, Vault), Appearance (theme), and the danger
 * zone (delete account + erase workspace). Account sections hide themselves
 * in demo mode and while offline — they're server-only operations.
 */
export default function SettingsModal({ onClose }: { onClose: () => void }) {
  const { theme, toggleTheme } = useNav();
  useVaultVersion();

  return (
    <Modal onClose={onClose} className="settings-modal" top="10vh">
      <div className="settings-head">
        <SettingsIcon size={16} />
        <span>Settings</span>
        <button className="icon-btn" onClick={onClose} aria-label="Close">
          <X size={16} />
        </button>
      </div>

      <div className="settings-body">
        {IS_MOCK ? (
          <div className="settings-section">
            <h3>Account</h3>
            <p className="settings-note">
              Demo mode has no account — sign-in, password and deletion live
              in the real app.
            </p>
          </div>
        ) : (
          <AccountSections onClose={onClose} />
        )}

        <div className="settings-section">
          <h3>Security</h3>
          <VaultRow />
          <TouchIdRow />
          {!vaultRootId() && !window.vellum?.touchId && (
            <p className="settings-note">
              Create a Vault (or use the Mac app for Touch ID) and its
              controls will appear here.
            </p>
          )}
        </div>

        <div className="settings-section">
          <h3>Appearance</h3>
          <div className="settings-row">
            <span className="settings-row-label">Theme</span>
            <div className="theme-picker">
              <button
                className={theme === "light" ? "active" : ""}
                onClick={() => theme !== "light" && toggleTheme()}
              >
                <Sun size={13} /> Light
              </button>
              <button
                className={theme === "dark" ? "active" : ""}
                onClick={() => theme !== "dark" && toggleTheme()}
              >
                <Moon size={13} /> Dark
              </button>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}

/** Vault status + lock control. Hidden until a vault exists. */
function VaultRow() {
  const unlocked = isVaultUnlocked();
  if (!vaultRootId()) return null;
  return (
    <div className="settings-row">
      <span className="settings-row-label">
        {unlocked ? <LockOpen size={14} /> : <Lock size={14} />}
        Vault
      </span>
      {unlocked ? (
        <button className="btn subtle" onClick={() => lockVault()}>
          Lock now
        </button>
      ) : (
        <span className="settings-note">Locked</span>
      )}
    </div>
  );
}

/** Touch ID enrollment management (Electron on a Mac only). */
function TouchIdRow() {
  const [touch, setTouch] = useState<{
    available: boolean;
    enrolled: boolean;
  } | null>(null);

  useEffect(() => {
    let alive = true;
    void window.vellum?.touchId?.status().then((s) => {
      if (alive) setTouch(s);
    });
    return () => {
      alive = false;
    };
  }, []);

  if (!touch?.available) return null;
  return (
    <div className="settings-row">
      <span className="settings-row-label">
        <Fingerprint size={14} />
        Touch ID sign-in
      </span>
      {touch.enrolled ? (
        <button
          className="btn subtle"
          onClick={() => {
            void window.vellum?.touchId?.clear();
            setTouch({ ...touch, enrolled: false });
          }}
        >
          Remove saved credentials
        </button>
      ) : (
        <span className="settings-note">
          Enable it from the sign-in screen
        </span>
      )}
    </div>
  );
}

/**
 * Server-backed account sections. A separate component because it uses
 * useAuthActions, which needs the auth provider mock mode doesn't mount.
 */
function AccountSections({ onClose }: { onClose: () => void }) {
  const account = useAccount();
  const { signOut } = useAuthActions();
  const [email, setEmail] = useState<string | null>(null);

  useEffect(() => {
    if (!account.available) return;
    let alive = true;
    void account.getEmail().then((e) => {
      if (alive) setEmail(e);
    });
    return () => {
      alive = false;
    };
  }, [account]);

  if (!account.available) {
    return (
      <div className="settings-section">
        <h3>Account</h3>
        <p className="settings-note">
          Account settings need a connection — reconnect to manage your
          password or sessions.
        </p>
      </div>
    );
  }

  return (
    <>
      <div className="settings-section">
        <h3>Account</h3>
        <div className="settings-row">
          <span className="settings-row-label">Email</span>
          <span className="settings-value">{email ?? "…"}</span>
        </div>
        <ChangePasswordForm email={email} />
        <div className="settings-row">
          <span className="settings-row-label">
            <LogOut size={14} />
            Sessions
          </span>
          <button
            className="btn subtle"
            onClick={() => {
              void (async () => {
                await account.signOutEverywhere();
                await signOut().catch(() => {});
                window.location.reload();
              })();
            }}
          >
            Sign out everywhere
          </button>
        </div>
      </div>

      <DangerZone account={account} onClose={onClose} />
    </>
  );
}

function ChangePasswordForm({ email }: { email: string | null }) {
  const account = useAccount();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const unmet = unmetPasswordRules(next);
  const blocked = !current || unmet.length > 0 || confirm !== next;

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (blocked || busy) return;
    setBusy(true);
    setError(null);
    try {
      await account.changePassword(current, next);
      // Keep Touch ID working: re-seal the credentials that just changed.
      const touch = await window.vellum?.touchId?.status();
      if (touch?.enrolled && email) {
        void window.vellum?.touchId?.save(email, next);
      }
      setDone(true);
      setOpen(false);
      setCurrent("");
      setNext("");
      setConfirm("");
    } catch (err) {
      setError(
        err instanceof Error && err.message.includes("incorrect")
          ? "The current password is incorrect."
          : ((err as { data?: string })?.data ??
              "Could not change the password — try again."),
      );
    } finally {
      setBusy(false);
    }
  };

  if (!open) {
    return (
      <div className="settings-row">
        <span className="settings-row-label">Password</span>
        {done && (
          <span className="settings-success">
            <Check size={13} /> Changed
          </span>
        )}
        <button className="btn subtle" onClick={() => setOpen(true)}>
          Change password
        </button>
      </div>
    );
  }

  return (
    <form className="settings-form" onSubmit={(e) => void submit(e)}>
      <label className="login-label" htmlFor="set-current">
        Current password
      </label>
      <input
        id="set-current"
        className="login-input"
        type="password"
        autoComplete="current-password"
        autoFocus
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <label className="login-label" htmlFor="set-next">
        New password
      </label>
      <input
        id="set-next"
        className="login-input"
        type="password"
        autoComplete="new-password"
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <ul className="pw-checks">
        {PASSWORD_RULES.map((rule) => {
          const ok = rule.test(next);
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
      <label className="login-label" htmlFor="set-confirm">
        Repeat new password
      </label>
      <input
        id="set-confirm"
        className="login-input"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {confirm.length > 0 && confirm !== next && (
        <div className="login-error">The passwords don't match.</div>
      )}
      {error && <div className="login-error">{error}</div>}
      <div className="settings-form-actions">
        <button
          type="button"
          className="btn subtle"
          onClick={() => setOpen(false)}
        >
          Cancel
        </button>
        <button
          className="btn primary"
          type="submit"
          disabled={busy || blocked}
        >
          {busy ? "Changing…" : "Change password"}
        </button>
      </div>
    </form>
  );
}

function DangerZone({
  account,
  onClose,
}: {
  account: ReturnType<typeof useAccount>;
  onClose: () => void;
}) {
  const { signOut } = useAuthActions();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [phrase, setPhrase] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const armed = phrase === "DELETE" && password.length > 0;

  const nuke = async () => {
    if (!armed || busy) return;
    setBusy(true);
    setError(null);
    try {
      await account.deleteAccount(password);
      // The server side is gone; scrub this device too.
      void window.vellum?.touchId?.clear();
      try {
        localStorage.removeItem("vellum:hasSession");
      } catch {
        /* ignore */
      }
      await new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase("vellum-offline");
        req.onsuccess = req.onerror = req.onblocked = () => resolve();
      });
      await signOut().catch(() => {});
      onClose();
      window.location.reload();
    } catch (err) {
      setError(
        (err as { data?: string })?.data ??
          "Could not delete the account — check the password.",
      );
      setBusy(false);
    }
  };

  return (
    <div className="settings-section danger">
      <h3>
        <AlertTriangle size={13} /> Danger zone
      </h3>
      {!open ? (
        <div className="settings-row">
          <span className="settings-note">
            Delete the owner account and erase every page, file, and version
            in this workspace.
          </span>
          <button className="btn subtle danger" onClick={() => setOpen(true)}>
            Delete account…
          </button>
        </div>
      ) : (
        <div className="settings-form">
          <p className="settings-note">
            This erases <strong>everything</strong> — pages, databases, the
            Vault, uploads, history, comments, and the account itself — on
            every device. There is no undo and no backup unless you exported
            one.
          </p>
          <label className="login-label" htmlFor="del-password">
            Your password
          </label>
          <input
            id="del-password"
            className="login-input"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <label className="login-label" htmlFor="del-phrase">
            Type DELETE to confirm
          </label>
          <input
            id="del-phrase"
            className="login-input"
            placeholder="DELETE"
            value={phrase}
            onChange={(e) => setPhrase(e.target.value)}
          />
          {error && <div className="login-error">{error}</div>}
          <div className="settings-form-actions">
            <button
              type="button"
              className="btn subtle"
              onClick={() => {
                setOpen(false);
                setPassword("");
                setPhrase("");
                setError(null);
              }}
            >
              Cancel
            </button>
            <button
              className="btn danger-solid"
              disabled={!armed || busy}
              onClick={() => void nuke()}
            >
              {busy ? "Erasing…" : "Delete account & erase workspace"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
