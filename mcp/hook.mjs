#!/usr/bin/env node
/**
 * Claude Code hook: mirror the session into the Claude database.
 *
 * Wire it as a `Stop` (and `SessionEnd`) hook in ~/.claude/settings.json;
 * see mcp/README.md. Claude Code pipes the event as JSON on stdin with
 * `session_id`, `transcript_path` and `cwd`; the transcript is re-read on
 * every turn and upserted into ONE row keyed by the session id, so the row
 * stays current even if the session is killed before SessionEnd fires.
 *
 * Never blocks Claude: any failure is logged to stderr and the hook exits
 * 0. Set VELLUM_HOOK_DISABLED=1 to switch it off for a shell.
 */
import fs from "node:fs";
import path from "node:path";
import { ClaudeLog } from "./lib/claudeDb.mjs";
import { localDate, parseTranscript, titleFromPrompt, transcriptToMarkdown } from "./lib/transcript.mjs";
import { VellumClient, describeError } from "./lib/vellum.mjs";

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

async function main() {
  if (process.env.VELLUM_HOOK_DISABLED === "1") return;
  let event;
  try {
    event = JSON.parse(await readStdin());
  } catch {
    console.error("vellum hook: stdin was not a hook payload");
    return;
  }
  const transcriptPath = event.transcript_path;
  const sessionId = event.session_id;
  if (!transcriptPath || !sessionId || !fs.existsSync(transcriptPath)) return;

  const { messages, firstTs } = parseTranscript(fs.readFileSync(transcriptPath, "utf8"));
  const firstPrompt = messages.find((m) => m.role === "user");
  if (!firstPrompt) return; // nothing was said yet

  const vellum = new VellumClient();
  const log = new ClaudeLog(vellum);
  const project = event.cwd ? path.basename(event.cwd) : undefined;
  const summary = firstPrompt.text.replace(/\s+/g, " ").slice(0, 240);
  const header = [
    `Claude Code session ${sessionId}${event.cwd ? ` in ${event.cwd}` : ""}.`,
    "",
  ].join("\n");
  const result = await log.upsert({
    key: sessionId,
    title: titleFromPrompt(firstPrompt.text),
    summary,
    bodyMarkdown: header + transcriptToMarkdown(messages),
    source: "Claude Code",
    project,
    date: localDate(firstTs),
    device: vellum.device(),
  });
  console.error(`vellum hook: ${result.created ? "logged" : "updated"} ${result.url}`);
}

try {
  await main();
} catch (err) {
  console.error(`vellum hook: ${describeError(err)}`);
}
process.exit(0);
