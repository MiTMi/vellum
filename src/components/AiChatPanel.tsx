import { useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  MessageSquarePlus,
  PanelRight,
  ChevronsRight,
  Plus,
  SlidersHorizontal,
  Mic,
  ArrowUp,
  Presentation,
  Languages,
  ScanSearch,
  UserRoundCog,
  FileText,
  Loader2,
  X,
} from "lucide-react";
import { AiChatMessage, PageId, PageMeta } from "../lib/types";
import { useAi, useMutations } from "../data";
import { isVaultPage } from "../lib/vaultSession";

/**
 * The docked AI chat panel — Vellum's take on Notion's right-hand AI pane.
 *
 * A sibling of `.main-col` inside `.app`'s flex row, so opening it narrows
 * the page rather than covering it. It replaced an earlier one-shot Q&A
 * modal: this does the same job (retrieval + citations) and also holds a
 * conversation, so keeping both would have meant two surfaces for one task.
 */

/** Custom instructions ("Personalize"). Local by design — it is a per-device
 *  preference, and routing it through the schema would sync a setting that
 *  only ever matters where it was typed. */
const PERSONA_KEY = "vellum:ai-persona";

function loadPersona(): string {
  try {
    return localStorage.getItem(PERSONA_KEY) ?? "";
  } catch {
    return "";
  }
}

interface Suggestion {
  id: string;
  label: string;
  icon: React.ReactNode;
  badge?: string;
  /** Needs an open, non-vault page to act on. */
  needsPage?: boolean;
}

const SUGGESTIONS: Suggestion[] = [
  { id: "personalize", label: "Personalize your Vellum AI", icon: <UserRoundCog size={17} /> },
  { id: "deck", label: "Create a slide deck", icon: <Presentation size={17} />, badge: "New", needsPage: true },
  { id: "translate", label: "Translate this page", icon: <Languages size={17} />, needsPage: true },
  { id: "insights", label: "Analyze for insights", icon: <ScanSearch size={17} />, needsPage: true },
];

export interface AiChatPanelProps {
  /** The open page — becomes the composer's context chip. */
  page: PageMeta | null;
  onClose: () => void;
  onOpenPage: (id: PageId) => void;
  width: number;
  setWidth: (w: number) => void;
}

export default function AiChatPanel({
  page,
  onClose,
  onOpenPage,
  width,
  setWidth,
}: AiChatPanelProps) {
  const ai = useAi();
  const mutations = useMutations();
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  /** The context chip is on by default when a page is open, and dismissible. */
  const [useContext, setUseContext] = useState(true);
  const [useWorkspace, setUseWorkspace] = useState(true);
  const [personaOpen, setPersonaOpen] = useState(false);
  const [persona, setPersona] = useState(loadPersona);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const resizing = useRef(false);

  // Vault pages must never become context — the server refuses them anyway,
  // but offering the chip would imply otherwise.
  const contextPage = page && !isVaultPage(page._id) ? page : null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, busy]);

  // Drag-to-resize from the panel's left edge, mirroring Sidebar's handle.
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!resizing.current) return;
      setWidth(Math.min(680, Math.max(300, window.innerWidth - e.clientX)));
    };
    const onUp = () => {
      resizing.current = false;
      document.body.style.cursor = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setWidth]);

  const savePersona = (value: string) => {
    setPersona(value);
    try {
      localStorage.setItem(PERSONA_KEY, value);
    } catch {
      // Private browsing / quota — the instruction just won't persist.
    }
  };

  const send = async (text: string) => {
    const content = text.trim();
    if (!content || busy) return;
    const next: AiChatMessage[] = [...messages, { role: "user", content }];
    setMessages(next);
    setInput("");
    setBusy(true);
    try {
      const res = await ai.converse({
        messages: next.map(({ role, content }) => ({ role, content })),
        pageId: useContext && contextPage ? contextPage._id : undefined,
        useWorkspace,
        persona: persona.trim() || undefined,
      });
      setMessages([
        ...next,
        { role: "assistant", content: res.answer, sources: res.sources },
      ]);
    } catch (err) {
      const data = (err as { data?: unknown }).data;
      setMessages([
        ...next,
        {
          role: "assistant",
          content: "",
          error:
            typeof data === "string"
              ? data
              : err instanceof Error
                ? err.message
                : "Something went wrong.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  /** "Create a slide deck" — generates an outline and lands it as a real page. */
  const makeDeck = async () => {
    if (busy) return;
    setBusy(true);
    setMessages((m) => [
      ...m,
      { role: "user", content: "Create a slide deck from this page" },
    ]);
    try {
      const outline = await ai.deckOutline({
        pageId: contextPage?._id,
        topic: contextPage?.title,
      });
      const id = await mutations.create({
        parentId: contextPage?._id,
        type: "doc",
        title: `${contextPage?.title ?? "Deck"} — slides`,
        icon: "📊",
      });
      // Heading + bullets per slide, mapped straight onto BlockNote blocks.
      const blocks = outline
        .split("\n")
        .filter((l) => l.trim())
        .map((line) =>
          line.startsWith("## ")
            ? { type: "heading", props: { level: 2 }, content: line.slice(3).trim() }
            : line.startsWith("- ")
              ? { type: "bulletListItem", content: line.slice(2).trim() }
              : { type: "paragraph", content: line.trim() },
        );
      await mutations.updateContent({
        id,
        content: blocks,
        text: outline,
      });
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: `Made a deck outline and put it in a new page.\n\n${outline}`,
          sources: [{ pageId: id, title: `${contextPage?.title ?? "Deck"} — slides`, icon: "📊" }],
        },
      ]);
    } catch (err) {
      const data = (err as { data?: unknown }).data;
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: "",
          error:
            typeof data === "string"
              ? data
              : err instanceof Error
                ? err.message
                : "Could not build the deck.",
        },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const runSuggestion = (s: Suggestion) => {
    if (s.id === "personalize") return setPersonaOpen(true);
    if (s.id === "deck") return void makeDeck();
    if (s.id === "translate")
      return void send("Translate this page into English. If it is already English, translate it into French.");
    if (s.id === "insights")
      return void send("Analyze this page and give me the key insights, risks, and anything I seem to have missed.");
  };

  const startNewChat = () => {
    setMessages([]);
    setInput("");
    inputRef.current?.focus();
  };

  return (
    <aside className="ai-panel" style={{ width }}>
      <div
        className="ai-panel-resize"
        onMouseDown={() => {
          resizing.current = true;
          document.body.style.cursor = "col-resize";
        }}
      />

      <header className="ai-panel-head">
        <button className="ai-panel-title" onClick={startNewChat}>
          {messages.length > 0 ? "AI chat" : "New AI chat"}
          <ChevronDown size={14} />
        </button>
        <div className="ai-panel-head-actions">
          <button className="icon-btn" title="New chat" onClick={startNewChat}>
            <MessageSquarePlus size={16} />
          </button>
          <button
            className={`icon-btn ${useWorkspace ? "active" : ""}`}
            title={
              useWorkspace
                ? "Searching your whole workspace"
                : "Only using the open page"
            }
            onClick={() => setUseWorkspace((v) => !v)}
          >
            <PanelRight size={16} />
          </button>
          <button className="icon-btn" title="Close" onClick={onClose}>
            <ChevronsRight size={16} />
          </button>
        </div>
      </header>

      <div className="ai-panel-scroll" ref={scrollRef}>
        {messages.length === 0 && !busy ? (
          <div className="ai-panel-empty">
            <div className="ai-panel-avatar">✳</div>
            <h2>Your Vellum AI</h2>
            <p>Here are a few things I can do, or ask me anything!</p>
            <div className="ai-panel-suggestions">
              {SUGGESTIONS.filter((s) => !s.needsPage || contextPage).map((s) => (
                <button
                  key={s.id}
                  className="ai-panel-suggestion"
                  onClick={() => runSuggestion(s)}
                >
                  <span className="ai-panel-suggestion-icon">{s.icon}</span>
                  {s.label}
                  {s.badge && <span className="ai-panel-badge">{s.badge}</span>}
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="ai-panel-thread">
            {messages.map((m, i) => (
              <div key={i} className={`ai-msg ai-msg-${m.role}`}>
                {m.error ? (
                  <div className="ai-menu-error">{m.error}</div>
                ) : (
                  <div className="ai-msg-body">{m.content}</div>
                )}
                {m.sources && m.sources.length > 0 && (
                  <div className="ai-msg-sources">
                    {m.sources.map((s) => (
                      <button
                        key={s.pageId}
                        className="ai-msg-source"
                        onClick={() => onOpenPage(s.pageId)}
                      >
                        {s.icon ? <span>{s.icon}</span> : <FileText size={12} />}
                        {s.title}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
            {busy && (
              <div className="ai-msg ai-msg-assistant">
                <div className="ai-msg-body ai-msg-thinking">
                  <Loader2 size={14} className="ai-spin" /> Thinking…
                </div>
              </div>
            )}
          </div>
        )}
      </div>

      {personaOpen && (
        <div className="ai-persona">
          <div className="ai-persona-head">
            <strong>Personalize</strong>
            <button className="icon-btn" onClick={() => setPersonaOpen(false)}>
              <X size={14} />
            </button>
          </div>
          <textarea
            rows={4}
            placeholder="e.g. Answer in British English. Be blunt. I'm a developer — skip the basics."
            value={persona}
            onChange={(e) => savePersona(e.target.value)}
          />
          <div className="ai-persona-hint">
            Sent with every message in this chat. Stored on this device only.
          </div>
        </div>
      )}

      <div className="ai-panel-composer">
        {useContext && contextPage && (
          <button
            className="ai-context-chip"
            title="Using this page as context — click to remove"
            onClick={() => setUseContext(false)}
          >
            <span className="ai-context-chip-icon">
              {contextPage.icon ?? "📄"}
            </span>
            <span className="ai-context-chip-label">
              {contextPage.title || "Untitled"}
            </span>
            <X size={12} />
          </button>
        )}
        <textarea
          ref={inputRef}
          rows={2}
          placeholder="Do anything with AI…"
          value={input}
          disabled={busy}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
        />
        <div className="ai-composer-foot">
          <button
            className="icon-btn"
            title={
              contextPage
                ? useContext
                  ? "Page context is on"
                  : "Add the open page as context"
                : "Open a page to add it as context"
            }
            disabled={!contextPage}
            onClick={() => setUseContext((v) => !v)}
          >
            <Plus size={16} />
          </button>
          <button
            className="icon-btn"
            title="Personalize"
            onClick={() => setPersonaOpen((v) => !v)}
          >
            <SlidersHorizontal size={16} />
          </button>
          <span className="ai-composer-model">Auto</span>
          <button className="icon-btn" title="Voice input is not available yet" disabled>
            <Mic size={16} />
          </button>
          <button
            className="ai-send"
            title="Send"
            disabled={busy || !input.trim()}
            onClick={() => void send(input)}
          >
            <ArrowUp size={15} />
          </button>
        </div>
      </div>
    </aside>
  );
}
