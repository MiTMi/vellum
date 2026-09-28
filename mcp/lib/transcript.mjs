/**
 * Claude Code transcript (`transcript_path` in a hook payload, JSONL) →
 * the conversation as the user saw it: their prompts and Claude's replies.
 *
 * Tool calls, tool results, thinking blocks, slash-command scaffolding and
 * meta lines are dropped — the log is a record of the conversation, not of
 * the machinery. Best-effort by design: the transcript format is Claude
 * Code's own and unversioned, so anything unrecognised is skipped, never
 * fatal.
 */

/** Per-message and per-page caps keep a long session inside one document. */
export const MAX_MESSAGE_CHARS = 6000;
export const MAX_BODY_CHARS = 120_000;

const SCAFFOLD = /^\s*<(command-name|command-message|command-args|local-command-stdout|local-command-stderr|system-reminder|bash-input|bash-stdout|bash-stderr|task-notification|ide_opened_file|ide_selection)\b/;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n\n");
}

/**
 * @param {string} jsonl
 * @returns {{ messages: {role: "user"|"assistant", text: string, ts: string|null}[], firstTs: string|null, lastTs: string|null }}
 */
export function parseTranscript(jsonl) {
  const messages = [];
  for (const line of String(jsonl ?? "").split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!entry || typeof entry !== "object") continue;
    if (entry.isMeta) continue;
    const role = entry.type === "user" || entry.type === "assistant" ? entry.type : null;
    if (!role || !entry.message) continue;
    const text = textOf(entry.message.content).trim();
    if (!text) continue;
    if (role === "user" && SCAFFOLD.test(text)) continue;
    const ts = typeof entry.timestamp === "string" ? entry.timestamp : null;
    const last = messages[messages.length - 1];
    // One assistant turn is spread over several lines when tools run in
    // between; fold them back into one reply.
    if (last && last.role === "assistant" && role === "assistant") {
      last.text += "\n\n" + text;
      if (ts) last.ts = ts;
    } else {
      messages.push({ role, text, ts });
    }
  }
  const stamps = messages.map((m) => m.ts).filter(Boolean);
  return {
    messages,
    firstTs: stamps[0] ?? null,
    lastTs: stamps[stamps.length - 1] ?? null,
  };
}

/** A row title from the opening prompt: first line, markdown stripped. */
export function titleFromPrompt(text, max = 80) {
  const line =
    String(text ?? "")
      .split("\n")
      .map((l) => l.replace(/^[#>\-*\s]+/, "").trim())
      .find(Boolean) ?? "";
  const clean = line.replace(/[`*_]/g, "").replace(/\s+/g, " ");
  if (clean.length <= max) return clean || "Untitled conversation";
  return clean.slice(0, max - 1).trimEnd() + "…";
}

function clip(text, max) {
  return text.length <= max ? text : text.slice(0, max) + "\n\n… (message truncated)";
}

/**
 * The conversation as Markdown the blocks helper understands: a level-3
 * heading per turn, then the text. Oversized sessions keep their opening
 * exchange and their most recent turns; the middle is elided with a note.
 */
export function transcriptToMarkdown(messages, opts = {}) {
  const maxMessage = opts.maxMessageChars ?? MAX_MESSAGE_CHARS;
  const maxBody = opts.maxBodyChars ?? MAX_BODY_CHARS;
  const entries = messages.map((m) => ({
    role: m.role,
    text: clip(m.text.trim(), maxMessage),
  }));
  let omitted = 0;
  const size = () => entries.reduce((n, e) => n + e.text.length + 16, 0);
  while (size() > maxBody && entries.length > 3) {
    entries.splice(2, 1);
    omitted += 1;
  }
  const parts = [];
  entries.forEach((e, i) => {
    if (omitted && i === 2) parts.push(`> … ${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted to fit …`);
    parts.push(`### ${e.role === "user" ? "You" : "Claude"}`);
    parts.push(e.text);
  });
  return parts.join("\n\n");
}

/** `YYYY-MM-DD` in local time for a database Date cell. */
export function localDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  const y = safe.getFullYear();
  const m = String(safe.getMonth() + 1).padStart(2, "0");
  const day = String(safe.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
