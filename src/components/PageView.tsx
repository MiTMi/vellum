import React, { useEffect, useRef, useState } from "react";
import {
  Smile,
  ImageIcon,
  Link2,
  ChevronDown,
  ChevronRight,
  FileText,
  Database,
} from "lucide-react";
import { PageDoc, PageId, PagesIndex, childrenKey } from "../lib/types";
import { usePage, useMutations, useBacklinks } from "../data";
import { useNav } from "../state";
import { coverBackground } from "../lib/colors";
import { extractText } from "../lib/blocks";
import Editor from "./Editor";
import Comments from "./Comments";
import DatabaseView from "./database/DatabaseView";
import RowPropsPanel from "./database/RowProps";
import IconPicker from "./IconPicker";
import CoverPicker from "./CoverPicker";
import VaultView, { VaultUnlock } from "./VaultView";
import {
  decryptJson,
  decryptTitle,
  isEncryptedContent,
  isVaultMeta,
} from "../lib/vaultCrypto";
import {
  isVaultUnlocked,
  useVaultVersion,
  vaultKey,
  vaultRootId,
} from "../lib/vaultSession";

interface PageViewProps {
  pageId: PageId;
  index: PagesIndex;
}

export default function PageView({ pageId, index }: PageViewProps) {
  const page = usePage(pageId);
  useVaultVersion(); // re-render on vault lock/unlock
  const parentMeta = page?.parentId ? index.byId.get(page.parentId) : undefined;
  const isRow = parentMeta?.type === "database";
  const database = usePage(isRow ? (page!.parentId as PageId) : null);

  if (page === undefined) {
    return <div className="page-loading" />;
  }
  if (page === null) {
    return (
      <div className="page-missing">
        <h2>Page not found</h2>
        <p>It may have been deleted.</p>
      </div>
    );
  }

  if (page.vault) {
    const isRoot = !parentMeta?.vault;
    if (isRoot) return <VaultView key={page._id} page={page} index={index} />;
    return <VaultPageGate key={page._id} page={page} index={index} />;
  }

  return (
    <PageBody
      key={page._id}
      page={page}
      index={index}
      database={isRow ? (database ?? null) : null}
    />
  );
}

/**
 * A page inside the Vault. Locked → the unlock form. Unlocked → decrypt
 * title/content in memory and hand a plaintext PageDoc to the ordinary
 * PageBody; every save goes back out through the data layer's encryption
 * wrapper, so plaintext never leaves this component tree.
 */
function VaultPageGate({ page, index }: { page: PageDoc; index: PagesIndex }) {
  useVaultVersion();
  const unlocked = isVaultUnlocked();
  const rootId = vaultRootId();
  const root = usePage(unlocked ? null : (rootId as PageId | null));
  const [dec, setDec] = useState<
    | { status: "ok"; id: string; title: string; content: unknown }
    | { status: "error"; id: string }
    | null
  >(null);

  useEffect(() => {
    if (!unlocked) {
      setDec(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const key = vaultKey();
        const title = await decryptTitle(key, page.title);
        const content = isEncryptedContent(page.content)
          ? await decryptJson(key, page.content)
          : (page.content ?? []);
        if (!cancelled) setDec({ status: "ok", id: page._id, title, content });
      } catch {
        // Never mount an editor over content we couldn't decrypt — a save
        // would overwrite the ciphertext with an empty document.
        if (!cancelled) setDec({ status: "error", id: page._id });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page._id, unlocked]);

  if (!unlocked) {
    const meta = isVaultMeta(root?.content) ? root!.content : null;
    return (
      <div className="page-view">
        <div className="page-inner">
          <div className="vault-head">
            <h1 className="vault-title">🔒 Locked page</h1>
            <p className="vault-sub">This page is in your encrypted Vault.</p>
          </div>
          {meta ? (
            <VaultUnlock meta={meta} index={index} />
          ) : (
            <div className="page-loading" />
          )}
        </div>
      </div>
    );
  }

  if (dec === null || dec.id !== page._id) {
    return <div className="page-loading" />;
  }
  if (dec.status === "error") {
    return (
      <div className="page-missing">
        <h2>Can't decrypt this page</h2>
        <p>
          It was encrypted with a different passphrase, or its data is
          incomplete. Lock and unlock the Vault to retry.
        </p>
      </div>
    );
  }

  return (
    <PageBody
      key={page._id}
      page={{ ...page, title: dec.title, content: dec.content }}
      index={index}
      database={null}
    />
  );
}

function PageBody({
  page,
  index,
  database,
}: {
  page: PageDoc;
  index: PagesIndex;
  database: PageDoc | null;
}) {
  const mutations = useMutations();
  const [title, setTitle] = useState(page.title);
  const [iconAnchor, setIconAnchor] = useState<HTMLElement | null>(null);
  const [coverAnchor, setCoverAnchor] = useState<HTMLElement | null>(null);
  const titleRef = useRef<HTMLTextAreaElement>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Sync local title when the server copy changes elsewhere (rename in
  // sidebar, another window) — but not while the user is typing here.
  const editingTitle = useRef(false);
  useEffect(() => {
    if (!editingTitle.current) setTitle(page.title);
  }, [page.title]);

  useEffect(() => {
    const el = titleRef.current;
    if (el) {
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    }
  }, [title]);

  // Debounced rename, flushed on unmount / flush-edits — a pending title
  // must survive page switches and the sync engine's id remaps.
  const pendingTitle = useRef<string | null>(null);
  const flushTitle = () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (pendingTitle.current === null) return;
    const value = pendingTitle.current;
    pendingTitle.current = null;
    void mutations.rename({ id: page._id, title: value.trim() });
  };

  const commitTitle = (value: string) => {
    setTitle(value);
    pendingTitle.current = value;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(flushTitle, 300);
  };

  useEffect(() => {
    window.addEventListener("beforeunload", flushTitle);
    window.addEventListener("vellum:flush-edits", flushTitle);
    return () => {
      window.removeEventListener("beforeunload", flushTitle);
      window.removeEventListener("vellum:flush-edits", flushTitle);
      flushTitle();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page._id]);

  const isDatabase = page.type === "database";
  // A viewer-role shared page renders exactly like a locked page — same
  // read-only affordances, different note below.
  const isViewer = page.role === "viewer";
  const locked = (page.locked ?? false) || isViewer;

  // Notion offers templates on a brand-new empty page. Same emptiness test
  // the Editor uses to decide whether to seed initialContent.
  const [appliedCount, setAppliedCount] = useState(0);
  const isEmpty = !Array.isArray(page.content) || page.content.length === 0;
  const showTemplatePrompt =
    !isDatabase &&
    !locked &&
    // Applying a template composes `duplicate`, which is owner-only — a
    // shared editor on a blank page must not be offered a throwing path.
    !page.role &&
    !page.isTemplate &&
    isEmpty &&
    appliedCount === 0 &&
    index.templates.length > 0;

  return (
    <div
      className={`page-view font-${page.font ?? "default"} ${page.smallText ? "small-text" : ""} ${locked ? "locked" : ""}`}
    >
      {page.cover && (
        <div className="page-cover" style={{ background: coverBackground(page.cover) }}>
          {!locked && (
            <div className="cover-actions">
              <button className="cover-btn" onClick={(e) => setCoverAnchor(e.currentTarget)}>
                Change cover
              </button>
            </div>
          )}
        </div>
      )}

      <div className={`page-inner ${isDatabase ? "wide" : ""} ${page.fullWidth ? "full" : ""}`}>
        <div className={`page-head ${page.cover ? "has-cover" : ""}`}>
          {page.icon && (
            <button
              className={`page-icon ${page.cover ? "overlap" : ""}`}
              onClick={(e) => !locked && setIconAnchor(e.currentTarget)}
              title={locked ? undefined : "Change icon"}
            >
              {page.icon}
            </button>
          )}

          {!locked && (
            <div className="page-head-actions">
              {!page.icon && (
                <button
                  className="head-action"
                  onClick={(e) => setIconAnchor(e.currentTarget)}
                >
                  <Smile size={14} /> Add icon
                </button>
              )}
              {!page.cover && (
                <button
                  className="head-action"
                  onClick={(e) => setCoverAnchor(e.currentTarget)}
                >
                  <ImageIcon size={14} /> Add cover
                </button>
              )}
            </div>
          )}
          {locked && (
            <div className="locked-note">
              {isViewer ? "👁 Shared with you — view only" : "🔒 Page locked"}
            </div>
          )}

          <textarea
            ref={titleRef}
            className="page-title"
            value={title}
            readOnly={locked}
            placeholder={isDatabase ? "Untitled database" : "Untitled"}
            rows={1}
            onFocus={() => (editingTitle.current = true)}
            onBlur={() => (editingTitle.current = false)}
            onChange={(e) => !locked && commitTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (document.querySelector(".bn-editor") as HTMLElement | null)?.focus();
              }
            }}
          />
        </div>

        {database && <RowPropsPanel row={page} database={database} />}

        {isDatabase ? (
          <DatabaseView page={page} index={index} locked={locked} />
        ) : (
          <>
            {showTemplatePrompt && (
              <TemplatePrompt
                page={page}
                index={index}
                onApplied={() => setAppliedCount((n) => n + 1)}
              />
            )}
            {/* Remount after applying a template: the editor memoizes its
                initialContent on page._id, so it would otherwise keep
                showing the empty document we just filled in. */}
            <Editor key={`${page._id}:${appliedCount}`} page={page} />
          </>
        )}

        <LinkedMentions pageId={page._id} />
        <Comments pageId={page._id} />
      </div>

      {iconAnchor && (
        <IconPicker
          anchor={iconAnchor}
          onClose={() => setIconAnchor(null)}
          onPick={(emoji) => void mutations.setIcon({ id: page._id, icon: emoji })}
          onRemove={
            page.icon
              ? () => void mutations.setIcon({ id: page._id, icon: null })
              : undefined
          }
        />
      )}
      {coverAnchor && (
        <CoverPicker
          anchor={coverAnchor}
          onClose={() => setCoverAnchor(null)}
          onPick={(cover) => void mutations.setCover({ id: page._id, cover })}
        />
      )}
    </div>
  );
}

/**
 * Notion's "start with a template" prompt on an empty page.
 *
 * Applying composes existing mutations rather than adding a new one: copy
 * the template's content/icon/cover onto this page, then `duplicate` each of
 * its children into it. Works fully offline — every op is one the outbox
 * already knows, and duplicate enqueues parent-before-child creates.
 */
function TemplatePrompt({
  page,
  index,
  onApplied,
}: {
  page: PageDoc;
  index: PagesIndex;
  onApplied: () => void;
}) {
  const mutations = useMutations();
  const [applyingId, setApplyingId] = useState<PageId | null>(null);
  // The template's *content* lives on the full doc, not on PageMeta — so
  // fetch it via the ordinary hook once the user picks one.
  const template = usePage(applyingId);
  const ranRef = useRef(false);

  useEffect(() => {
    if (!applyingId || !template || ranRef.current) return;
    ranRef.current = true;
    void (async () => {
      const content = template.content ?? [];
      await mutations.updateContent({
        id: page._id,
        content,
        text: extractText(content),
      });
      if (template.icon && !page.icon) {
        await mutations.setIcon({ id: page._id, icon: template.icon });
      }
      if (template.cover && !page.cover) {
        await mutations.setCover({ id: page._id, cover: template.cover });
      }
      for (const child of index.children.get(childrenKey(applyingId)) ?? []) {
        await mutations.duplicate({
          id: child._id,
          parentId: page._id,
          suffix: "",
        });
      }
      onApplied();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [applyingId, template]);

  if (applyingId) {
    return <div className="template-prompt busy">Applying template…</div>;
  }

  return (
    <div className="template-prompt">
      <span className="template-prompt-label">Start with a template</span>
      <div className="template-prompt-list">
        {index.templates.map((t) => (
          <button
            key={t._id}
            className="template-prompt-btn"
            onClick={() => setApplyingId(t._id)}
          >
            <span className="tree-icon">
              {t.icon ?? <FileText size={14} />}
            </span>
            <span>{t.title || "Untitled"}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

/**
 * "Linked mentions" — every page whose content links here, Notion-style.
 * Hidden when the page has no backlinks.
 */
function LinkedMentions({ pageId }: { pageId: PageId }) {
  const backlinks = useBacklinks(pageId);
  const { navigate } = useNav();
  const [open, setOpen] = useState(true);

  if (!backlinks || backlinks.length === 0) return null;

  return (
    <div className="backlinks">
      <button className="backlinks-header" onClick={() => setOpen((o) => !o)}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <Link2 size={13} />
        <span>
          {backlinks.length} linked mention{backlinks.length === 1 ? "" : "s"}
        </span>
      </button>
      {open &&
        backlinks.map((b) => (
          <button
            key={b._id}
            className="backlink-item"
            onClick={() => navigate(b._id)}
          >
            <span className="backlink-icon">
              {b.icon ? (
                b.icon
              ) : b.type === "database" ? (
                <Database size={14} />
              ) : (
                <FileText size={14} />
              )}
            </span>
            <span className="backlink-title">{b.title || "Untitled"}</span>
          </button>
        ))}
    </div>
  );
}
