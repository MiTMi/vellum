import React, { useState } from "react";
import { FileText, Lock, LockOpen, Plus, ShieldCheck } from "lucide-react";
import { PageDoc, PageId, PagesIndex } from "../lib/types";
import { useMutations } from "../data";
import { useNav } from "../state";
import {
  VaultMeta,
  createVaultMeta,
  deriveVaultKey,
  isVaultMeta,
} from "../lib/vaultCrypto";
import {
  displayTitle,
  isVaultUnlocked,
  lockVault,
  unlockVault,
  useVaultVersion,
} from "../lib/vaultSession";

const MIN_PASSPHRASE = 8;

/**
 * The vault root page. Not an editor: its content holds the vault meta
 * (salt + encrypted passphrase check), and its body is the setup form, the
 * unlock form, or — while unlocked — the list of encrypted pages inside.
 */
export default function VaultView({
  page,
  index,
}: {
  page: PageDoc;
  index: PagesIndex;
}) {
  useVaultVersion();
  const meta = isVaultMeta(page.content) ? page.content : null;
  const unlocked = isVaultUnlocked();

  return (
    <div className="page-view">
      <div className="page-inner">
        <div className="vault-head">
          <span className="vault-badge">
            <Lock size={22} />
          </span>
          <h1 className="vault-title">Vault</h1>
          <p className="vault-sub">
            End-to-end encrypted. Pages in the Vault are ciphertext everywhere
            — on the server, in sync, on disk — and readable only here, after
            you unlock them.
          </p>
        </div>

        {!meta ? (
          <VaultSetup page={page} index={index} />
        ) : !unlocked ? (
          <VaultUnlock meta={meta} index={index} />
        ) : (
          <VaultContents page={page} index={index} />
        )}
      </div>
    </div>
  );
}

/** First run: choose the passphrase that becomes the encryption key. */
function VaultSetup({ page, index }: { page: PageDoc; index: PagesIndex }) {
  const mutations = useMutations();
  const [pass, setPass] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pass.length < MIN_PASSPHRASE) {
      setError(`Use at least ${MIN_PASSPHRASE} characters.`);
      return;
    }
    if (pass !== confirm) {
      setError("The passphrases don't match.");
      return;
    }
    setBusy(true);
    try {
      const { meta, key } = await createVaultMeta(pass);
      // The root's content *is* the vault meta — the mutations wrapper
      // deliberately leaves the root unencrypted.
      await mutations.updateContent({ id: page._id, content: meta, text: "" });
      await unlockVault(key, meta, index.all);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="vault-card" onSubmit={(e) => void submit(e)}>
      <h2>Set your Vault passphrase</h2>
      <p className="vault-note">
        This passphrase becomes the encryption key. It never leaves this
        device and is never sent to the server.
      </p>
      <input
        className="vault-input"
        type="password"
        placeholder="Passphrase"
        value={pass}
        autoFocus
        onChange={(e) => setPass(e.target.value)}
      />
      <input
        className="vault-input"
        type="password"
        placeholder="Repeat passphrase"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
      />
      {error && <div className="vault-error">{error}</div>}
      <button className="vault-btn" type="submit" disabled={busy}>
        <ShieldCheck size={15} />
        {busy ? "Creating…" : "Create Vault"}
      </button>
      <p className="vault-warning">
        There is no reset and no recovery. If you forget the passphrase,
        what's inside is gone for good — that's the point.
      </p>
    </form>
  );
}

/** Shared by the root view and by locked vault pages (PageView). */
export function VaultUnlock({
  meta,
  index,
}: {
  meta: VaultMeta;
  index: PagesIndex;
}) {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!pass) return;
    setBusy(true);
    setError(null);
    try {
      const key = await deriveVaultKey(pass, meta.salt);
      const ok = await unlockVault(key, meta, index.all);
      if (!ok) {
        setError("Wrong passphrase.");
        setPass("");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="vault-card" onSubmit={(e) => void submit(e)}>
      <h2>Unlock the Vault</h2>
      <input
        className="vault-input"
        type="password"
        placeholder="Passphrase"
        value={pass}
        autoFocus
        onChange={(e) => setPass(e.target.value)}
      />
      {error && <div className="vault-error">{error}</div>}
      <button className="vault-btn" type="submit" disabled={busy || !pass}>
        <LockOpen size={15} />
        {busy ? "Unlocking…" : "Unlock"}
      </button>
    </form>
  );
}

/** Unlocked: the encrypted pages, with their decrypted titles. */
function VaultContents({ page, index }: { page: PageDoc; index: PagesIndex }) {
  const mutations = useMutations();
  const { navigate } = useNav();

  const children = index.all
    .filter((p) => p.vault && p.parentId === page._id)
    .sort((a, b) => a.rank - b.rank);

  const newPage = async () => {
    const id = await mutations.create({ parentId: page._id, type: "doc" });
    navigate(id);
  };

  return (
    <div className="vault-contents">
      <div className="vault-toolbar">
        <button className="vault-btn" onClick={() => void newPage()}>
          <Plus size={15} /> New page
        </button>
        <button className="vault-btn subtle" onClick={() => lockVault()}>
          <Lock size={14} /> Lock now
        </button>
      </div>
      {children.length === 0 ? (
        <div className="vault-empty">
          Nothing here yet. Pages you create inside the Vault are encrypted
          before they leave this window.
        </div>
      ) : (
        <div className="vault-list">
          {children.map((p) => (
            <button
              key={p._id}
              className="vault-item"
              onClick={() => navigate(p._id)}
            >
              <span className="tree-icon">
                {p.icon ?? <FileText size={15} />}
              </span>
              <span className="tree-title">
                {displayTitle(p) || "Untitled"}
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="vault-note">
        The Vault locks itself after 15 minutes without activity, and always
        on reload. Publishing and search stay off inside.
      </p>
    </div>
  );
}
