import React, { useMemo, useRef, useState } from "react";
import {
  Copy,
  ClipboardCopy,
  CornerUpRight,
  Trash2,
  Lock,
  Download,
  Upload,
  Table,
  FileText,
  FileDown,
  Database,
  Search,
  Check,
  LayoutTemplate,
  History,
} from "lucide-react";
import Popover from "./ui/Popover";
import { PageId, PageMeta, PagesIndex, childrenKey } from "../lib/types";
import { useMutations, usePage, useVersionHistory } from "../data";
import HistoryModal from "./HistoryModal";
import { useNav } from "../state";
import {
  copyPageMarkdown,
  exportDatabaseCSV,
  exportPageHTML,
  exportPageMarkdown,
  exportPagePDF,
  importFileIntoPage,
} from "../lib/exporters";
import { extractText } from "../lib/blocks";

interface PageMenuProps {
  anchor: HTMLElement;
  onClose: () => void;
  page: PageMeta;
  index: PagesIndex;
}

export default function PageMenu({ anchor, onClose, page, index }: PageMenuProps) {
  const mutations = useMutations();
  const { navigate } = useNav();
  const fullPage = usePage(page._id);
  const history = useVersionHistory();
  const [view, setView] = useState<"main" | "move">("main");
  // Shared-with-me pages (Phase 2): duplicate/move/trash/lock/template/
  // history are owner-only; viewers additionally lose every write toggle.
  const shared = page.role !== undefined;
  const isViewer = page.role === "viewer";
  const [copied, setCopied] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [pdfBusy, setPdfBusy] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);

  const isDatabase = page.type === "database";
  const rows = index.children.get(childrenKey(page._id)) ?? [];
  const font = fullPage?.font ?? "default";

  const wordCount = useMemo(() => {
    const body = fullPage?.contentText ?? extractText(fullPage?.content);
    const text = `${page.title} ${body}`.trim();
    return text ? text.split(/\s+/).length : 0;
  }, [fullPage?.contentText, fullPage?.content, page.title]);

  const setOpt = (
    patch: Partial<{
      font: "default" | "serif" | "mono";
      smallText: boolean;
      fullWidth: boolean;
      locked: boolean;
    }>,
  ) => void mutations.setPageOptions({ id: page._id, ...patch });

  // Rendered in place of the popover: the menu must stay mounted (the parent
  // unmounts it on `onClose`), so the popover only really goes away once the
  // modal does.
  if (historyOpen) {
    return (
      <HistoryModal
        page={page}
        onClose={() => {
          setHistoryOpen(false);
          onClose();
        }}
      />
    );
  }

  if (view === "move") {
    return (
      <MovePanel
        anchor={anchor}
        onClose={onClose}
        page={page}
        index={index}
      />
    );
  }

  return (
    <Popover anchor={anchor} onClose={onClose} align="right" width={280} className="menu page-menu">
      <div className="font-row">
        {(
          [
            ["default", "Default"],
            ["serif", "Serif"],
            ["mono", "Mono"],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            className={`font-option font-${key} ${font === key ? "active" : ""}`}
            onClick={() => setOpt({ font: key })}
          >
            <span className="font-sample">Ag</span>
            <span className="font-label">{label}</span>
          </button>
        ))}
      </div>
      <div className="menu-divider" />

      {!isDatabase && (
        <button
          className="menu-item"
          onClick={async () => {
            const ok = await copyPageMarkdown(page.title);
            if (ok) {
              setCopied(true);
              setTimeout(() => {
                setCopied(false);
                onClose();
              }, 900);
            }
          }}
        >
          <span className="menu-icon">
            {copied ? <Check size={15} /> : <ClipboardCopy size={15} />}
          </span>
          <span>{copied ? "Copied!" : "Copy page contents"}</span>
        </button>
      )}
      {!shared && (
        <>
          <button
            className="menu-item"
            onClick={async () => {
              onClose();
              const id = await mutations.duplicate({ id: page._id });
              if (id) navigate(id);
            }}
          >
            <span className="menu-icon">
              <Copy size={15} />
            </span>
            <span>Duplicate</span>
            <span className="menu-kbd">⌘D</span>
          </button>
          <button className="menu-item" onClick={() => setView("move")}>
            <span className="menu-icon">
              <CornerUpRight size={15} />
            </span>
            <span>Move to</span>
            <span className="menu-kbd">›</span>
          </button>
          <button
            className="menu-item danger"
            onClick={() => {
              onClose();
              void mutations.trash({ id: page._id });
              navigate(null);
            }}
          >
            <span className="menu-icon">
              <Trash2 size={15} />
            </span>
            <span>Move to Trash</span>
          </button>

          <div className="menu-divider" />
        </>
      )}
      {!isViewer && (
        <>
          <ToggleRow
            label="Small text"
            checked={fullPage?.smallText ?? false}
            onChange={(v) => setOpt({ smallText: v })}
          />
          <ToggleRow
            label="Full width"
            checked={fullPage?.fullWidth ?? false}
            onChange={(v) => setOpt({ fullWidth: v })}
          />
          <div className="menu-divider" />
        </>
      )}
      {!shared && (
        <>
          <ToggleRow
            label="Lock page"
            icon={<Lock size={15} />}
            checked={fullPage?.locked ?? false}
            onChange={(v) => setOpt({ locked: v })}
          />
          <ToggleRow
            label="Template"
            icon={<LayoutTemplate size={15} />}
            checked={fullPage?.isTemplate ?? false}
            onChange={(v) =>
              void mutations.setTemplate({ id: page._id, value: v })
            }
          />
        </>
      )}
      {!isDatabase && !shared && (
        <button
          className="menu-item"
          disabled={!history.available}
          title={
            history.available
              ? undefined
              : "Page history needs a connection — reconnect to browse versions."
          }
          onClick={() => setHistoryOpen(true)}
        >
          <span className="menu-icon">
            <History size={15} />
          </span>
          <span>Page history</span>
        </button>
      )}

      <div className="menu-divider" />
      {!isDatabase && (
        <>
          <button
            className="menu-item"
            disabled={fullPage?.locked || isViewer}
            onClick={() => importRef.current?.click()}
          >
            <span className="menu-icon">
              <Download size={15} />
            </span>
            <span>Import Markdown or HTML…</span>
          </button>
          <input
            ref={importRef}
            type="file"
            accept=".md,.markdown,.txt,.html,.htm"
            hidden
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) {
                await importFileIntoPage(file);
                onClose();
              }
            }}
          />
          <button
            className="menu-item"
            onClick={async () => {
              await exportPageMarkdown(page.title);
              onClose();
            }}
          >
            <span className="menu-icon">
              <Upload size={15} />
            </span>
            <span>Export as Markdown</span>
          </button>
          <button
            className="menu-item"
            onClick={async () => {
              await exportPageHTML(page.title);
              onClose();
            }}
          >
            <span className="menu-icon">
              <FileText size={15} />
            </span>
            <span>Export as HTML</span>
          </button>
          <button
            className="menu-item"
            disabled={pdfBusy}
            onClick={async () => {
              setPdfBusy(true);
              const res = await exportPagePDF(page.title);
              setPdfBusy(false);
              // "printed" hands off to the browser's print dialog, which the
              // user drives — closing the menu underneath it is fine.
              if (res !== "failed") onClose();
            }}
          >
            <span className="menu-icon">
              <FileDown size={15} />
            </span>
            <span>{pdfBusy ? "Preparing PDF…" : "Export as PDF"}</span>
          </button>
        </>
      )}
      {isDatabase && (
        <button
          className="menu-item"
          onClick={() => {
            exportDatabaseCSV(page.title, fullPage?.dbProps ?? [], rows);
            onClose();
          }}
        >
          <span className="menu-icon">
            <Table size={15} />
          </span>
          <span>Export as CSV</span>
        </button>
      )}

      <div className="menu-footer">
        <div>
          {isDatabase
            ? `${rows.length} ${rows.length === 1 ? "row" : "rows"}`
            : `Word count: ${wordCount} ${wordCount === 1 ? "word" : "words"}`}
        </div>
        <div>
          Last edited{" "}
          {new Date(page.updatedAt).toLocaleString(undefined, {
            month: "short",
            day: "numeric",
            year: "numeric",
            hour: "numeric",
            minute: "2-digit",
          })}
        </div>
      </div>
    </Popover>
  );
}

/* ------------------------------------------------------------------ */

function ToggleRow({
  label,
  icon,
  checked,
  onChange,
}: {
  label: string;
  icon?: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button className="menu-item toggle-row" onClick={() => onChange(!checked)}>
      {icon && <span className="menu-icon">{icon}</span>}
      <span>{label}</span>
      <span className={`switch ${checked ? "on" : ""}`} role="switch" aria-checked={checked}>
        <span className="switch-knob" />
      </span>
    </button>
  );
}

/* ------------------------------------------------------------------ */

function MovePanel({
  anchor,
  onClose,
  page,
  index,
}: {
  anchor: HTMLElement;
  onClose: () => void;
  page: PageMeta;
  index: PagesIndex;
}) {
  const mutations = useMutations();
  const [term, setTerm] = useState("");

  // Exclude the page itself and its whole subtree as move targets.
  const excluded = useMemo(() => {
    const set = new Set<string>([page._id]);
    const stack = [page._id as string];
    while (stack.length) {
      const id = stack.pop()!;
      for (const kid of index.children.get(id) ?? []) {
        set.add(kid._id);
        stack.push(kid._id);
      }
    }
    return set;
  }, [page._id, index]);

  const candidates = useMemo(() => {
    const t = term.trim().toLowerCase();
    return index.all
      .filter(
        (p) =>
          !excluded.has(p._id) &&
          p._id !== page.parentId &&
          (!t || p.title.toLowerCase().includes(t)),
      )
      .slice(0, 12);
  }, [index, excluded, term, page.parentId]);

  const moveTo = (target: PageMeta | null) => {
    const siblings = index.children.get(childrenKey(target?._id ?? null)) ?? [];
    const last = siblings[siblings.length - 1];
    void mutations.move({
      id: page._id,
      parentId: target?._id,
      rank: last ? last.rank + 1024 : 1024,
    });
    onClose();
  };

  return (
    <Popover anchor={anchor} onClose={onClose} align="right" width={280} className="menu">
      <div className="qs-input-row small">
        <Search size={14} />
        <input
          autoFocus
          placeholder="Move page to…"
          value={term}
          onChange={(e) => setTerm(e.target.value)}
        />
      </div>
      {page.parentId && (
        <button className="menu-item" onClick={() => moveTo(null)}>
          <span className="menu-icon">
            <CornerUpRight size={15} />
          </span>
          <span>Move to top level</span>
        </button>
      )}
      {candidates.map((p) => (
        <button key={p._id} className="menu-item" onClick={() => moveTo(p)}>
          <span className="menu-icon">
            {p.icon ? (
              p.icon
            ) : p.type === "database" ? (
              <Database size={15} />
            ) : (
              <FileText size={15} />
            )}
          </span>
          <span className="move-title">{p.title || "Untitled"}</span>
        </button>
      ))}
      {candidates.length === 0 && <div className="select-empty">No pages found</div>}
    </Popover>
  );
}
