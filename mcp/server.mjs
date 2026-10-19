#!/usr/bin/env node
/**
 * Vellum MCP server for Claude Desktop (stdio).
 *
 *   node mcp/server.mjs login    sign in once; stores a refresh token, not the password
 *   node mcp/server.mjs check    verify the session and the Claude database
 *   node mcp/server.mjs          run the MCP server (what Claude Desktop launches)
 *
 * Over stdio the protocol owns stdout, so every log line goes to stderr —
 * including anything a dependency prints with console.log.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createInterface } from "node:readline";
import { ClaudeLog } from "./lib/claudeDb.mjs";
import { registerVellumTools } from "./lib/tools.mjs";
import { VellumClient, credentialsPath, deviceName, describeError } from "./lib/vellum.mjs";

const VERSION = "1.0.0";

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) {
      // Echo nothing while a password is typed.
      rl._writeToOutput = function (s) {
        if (s.includes(question)) process.stderr.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stderr.write("\n");
      resolve(answer.trim());
    });
  });
}

function flag(name) {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function login() {
  const vellum = new VellumClient();
  const email = process.env.VELLUM_EMAIL || flag("--email") || (await ask("Vellum email: "));
  const password = process.env.VELLUM_PASSWORD || (await ask("Vellum password: ", { hidden: true }));
  const suggested = deviceName(vellum.credentials());
  const device =
    process.env.VELLUM_DEVICE ||
    flag("--device") ||
    (await ask(`Name for this machine in the Device column [${suggested}]: `)) ||
    suggested;
  try {
    await vellum.login({ email, password, device });
  } catch (err) {
    console.error(`Sign-in failed: ${describeError(err)}`);
    process.exit(1);
  }
  console.error(`Signed in as ${email}. Session saved to ${credentialsPath()} (device: ${device}).`);
  await check(vellum);
}

async function check(vellum = new VellumClient()) {
  try {
    const pages = await vellum.query("pages:list");
    const { id } = await new ClaudeLog(vellum).database();
    console.error(
      `OK — ${pages.length} pages visible; Claude database ready (${vellum.pageUrl(id)}); device "${vellum.device()}".`,
    );
  } catch (err) {
    console.error(`Check failed: ${describeError(err)}`);
    process.exit(1);
  }
}

async function serve() {
  // Belt and braces: nothing but JSON-RPC may reach stdout.
  console.log = (...args) => console.error(...args);
  console.info = console.log;
  const vellum = new VellumClient();
  const log = new ClaudeLog(vellum);
  const server = new McpServer({ name: "vellum-mcp-server", version: VERSION });
  registerVellumTools(server, { log, vellum });
  await server.connect(new StdioServerTransport());
  console.error(`vellum-mcp-server ${VERSION} ready (device "${vellum.device()}")`);
}

const command = process.argv[2];
if (command === "login") await login();
else if (command === "check") await check();
else if (command === undefined || command === "serve") await serve();
else {
  console.error(`Unknown command "${command}". Use: login | check | serve`);
  process.exit(2);
}
