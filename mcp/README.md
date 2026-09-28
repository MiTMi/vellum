# Vellum for Claude — MCP server and Claude Code hook

Everything you do with Claude lands in a **"Claude" database** in your Vellum
workspace, one row per conversation: title, date, which Mac, where it
happened (Claude Desktop or Claude Code), project, tags, a summary, and the
notes or transcript as the row's page. Both Macs write to the same
workspace, so a chat logged on the Mac mini shows up on the MacBook Pro
(and offline in the app) like any other page.

Two pieces, sharing one sign-in:

| Piece | What it does | How automatic |
| --- | --- | --- |
| `mcp/server.mjs` | An MCP server Claude Desktop launches. Gives Claude tools to log the conversation, update it, list past ones, search and read your pages, create pages. | Claude calls the tools when you ask — or on its own if you give it a standing instruction (below). |
| `mcp/hook.mjs` | A Claude Code hook. After every turn it mirrors the session's transcript into its row. | Fully automatic. |

Nothing changed on the backend: both sign in as you through the app's own
auth and call the ordinary page functions, so the log lives outside the
Vault and obeys the same rules as anything typed in the app.

## Set up (once per Mac)

Do this on the Mac mini and again on the MacBook Pro.

1. Have the repository checked out and installed:

   ```sh
   cd ~/path/to/vellum
   npm install
   ```

2. Sign in. This stores a **refresh token**, never your password, in
   `~/.config/vellum-mcp/credentials.json` (mode 0600), together with the
   name this machine gets in the Device column:

   ```sh
   npm run mcp:login
   # Vellum email: …
   # Vellum password: …
   # Name for this machine in the Device column [studio]: Mac mini
   ```

   It ends by creating the Claude database if you don't have one yet and
   printing its link. `npm run mcp:check` repeats that check any time.

3. Register the server with Claude Desktop. Edit
   `~/Library/Application Support/Claude/claude_desktop_config.json`
   (create it if missing) — use **absolute paths**, and the absolute path to
   `node` (`which node`), because Claude Desktop does not load your shell
   profile:

   ```json
   {
     "mcpServers": {
       "vellum": {
         "command": "/opt/homebrew/bin/node",
         "args": ["/Users/you/path/to/vellum/mcp/server.mjs"]
       }
     }
   }
   ```

   Quit and reopen Claude Desktop. The tools appear under the connector
   icon, and "Log this conversation to Vellum" appears as a prompt in the
   **+** menu.

4. Tell Claude to log every conversation. Claude Desktop has no hook that
   fires when a chat ends, so this part is an instruction, not a mechanism.
   In **Settings → Profile → personal preferences** (or a Project's custom
   instructions) add something like:

   > At the end of every conversation, and whenever I say "log this", save a
   > record to Vellum with the vellum_log_conversation tool: a short title,
   > a summary of what I asked and what we concluded, notes in Markdown
   > (decisions, action items as a checklist), and tags. If you already
   > logged this conversation, pass the same conversation_key so the row is
   > updated. Tell me the link.

   Claude follows this nearly every time. You can always say "log this to
   Vellum" yourself, or pick the prompt from the **+** menu.

5. Automatic logging for Claude Code (terminal, or the Desktop app's Code
   tab). Add to `~/.claude/settings.json` (same file on both Macs):

   ```json
   {
     "hooks": {
       "Stop": [
         { "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/node /Users/you/path/to/vellum/mcp/hook.mjs", "timeout": 30 }] }
       ],
       "SessionEnd": [
         { "hooks": [{ "type": "command", "command": "/opt/homebrew/bin/node /Users/you/path/to/vellum/mcp/hook.mjs", "timeout": 30 }] }
       ]
     }
   }
   ```

   Every turn upserts **one row per session** (keyed by the session id in
   the Session column): the title is your first prompt, the page holds the
   conversation as "You" / "Claude" turns (tool calls and results are left
   out), Project is the folder name, Source is "Claude Code". The hook never
   blocks Claude — errors go to stderr and it exits 0. `VELLUM_HOOK_DISABLED=1`
   switches it off for a shell.

## The database

Created at the top level of your workspace, titled **Claude**, and found by
that title afterwards (rename the columns freely; they are matched by id,
and a deleted column is re-added on the next log):

| Column | Type | Filled with |
| --- | --- | --- |
| Date | date | day of the conversation |
| Device | select | this machine's name (from login, or `VELLUM_DEVICE`) |
| Source | select | Claude Desktop · Claude Code · Claude.ai · Other |
| Project | text | project or area; the folder name for Claude Code |
| Tags | multi-select | topic tags Claude picks |
| Summary | text | two to four sentences |
| Session | text | the key a row is updated by (session id / conversation_key) |

Switch it to a board grouped by Device, or a calendar on Date, like any
other database.

## Tools

- `vellum_log_conversation` — create or update (by `conversation_key`) a row.
- `vellum_update_conversation` — retitle, re-tag, append or replace notes.
- `vellum_list_conversations` — recent rows, filterable by device, source, project, date.
- `vellum_search` — full-text search over your pages (Vault pages never appear).
- `vellum_list_pages` — the workspace outline with ids.
- `vellum_read_page` — a page as Markdown, or a database's rows. Refuses Vault pages.
- `vellum_create_page` — a new page with Markdown, optionally under a parent.

Row and page links are `https://vellum-gilt.vercel.app/app#/page/<id>`.

## Environment

| Variable | Purpose |
| --- | --- |
| `VELLUM_CREDENTIALS` | credentials file path (default `~/.config/vellum-mcp/credentials.json`) |
| `VELLUM_DEVICE` | overrides the Device name |
| `VELLUM_CONVEX_URL` | backend (default: production) |
| `VELLUM_SITE_URL` | origin used in links (default `https://vellum-gilt.vercel.app`) |
| `VELLUM_EMAIL` / `VELLUM_PASSWORD` | headless sign-in when no refresh token is valid (a fresh machine, CI) |

Access tokens last an hour and are refreshed with the stored refresh token,
under a file lock so the long-running server and a hook firing at the same
moment can't invalidate each other's session. If a refresh token expires
(30 days unused) or you sign out everywhere, run `npm run mcp:login` again.

## Backfilling old chats

Claude Desktop's own history is only reachable through **Settings → Privacy →
Export data**. The export is JSON; each conversation can be pushed through
`vellum_log_conversation` (or `ClaudeLog.upsert` in `mcp/lib/claudeDb.mjs`
from a script) with its title as the `conversation_key`, so re-running an
import never duplicates rows.
