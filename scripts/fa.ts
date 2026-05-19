#!/usr/bin/env bun
/**
 * Fanwan agent CLI. Thin wrapper over the HTTP API.
 *
 * Usage (run via `bun run scripts/fa.ts <cmd>` or alias `fa` in your shell):
 *   fa health
 *   fa add "feed cat" --at "2026-05-20 09:00" --channel default --alert
 *   fa add "buy milk"                                      # memo only
 *   fa list                                                # pending + upcoming
 *   fa list --all
 *   fa get <id>
 *   fa edit <id> --content "..." --at "..." --status done
 *   fa rm <id>
 *   fa trigger <id>
 *   fa call "test message"                                 # immediate phone call
 *   fa call "test" --channel default
 *   fa channel list
 *   fa channel add phone <name> <webhook_url>
 *   fa channel rm <id>
 *   fa events [--entry <id>] [--limit 20]
 *
 * Output is JSON to stdout; human-friendly summary to stderr.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function loadEnv() {
  const p = resolve(process.cwd(), ".env");
  if (!existsSync(p)) return;
  for (const line of readFileSync(p, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, "");
  }
}
loadEnv();

const PORT = process.env.SERVER_PORT ?? "51737";
const BASE = process.env.API_BASE_URL ?? `http://localhost:${PORT}`;
const TOKEN = process.env.API_TOKEN || "";

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body == null ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    console.error(`[fa] cannot reach ${BASE} — is the server running? (bun run server)`);
    console.error(`     ${(e as Error).message}`);
    process.exit(2);
  }
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    console.error(`[fa] HTTP ${res.status}: ${typeof data === "string" ? data : data.error ?? text}`);
    process.exit(1);
  }
  return data;
}

interface Flags { _: string[]; [k: string]: string | boolean | string[] }

function parseArgs(argv: string[]): Flags {
  const out: Flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next == null || next.startsWith("--")) out[key] = true;
      else { out[key] = next; i++; }
    } else {
      out._.push(a);
    }
  }
  return out;
}

function print(obj: unknown) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}

function fmtEntry(e: any): string {
  const when = e.scheduled_at ? e.scheduled_at : "—";
  const ring = e.alert ? "🔔" : "·";
  return `#${e.id} [${e.status}] ${ring} ${when}  ${e.content}`;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

async function main() {
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      console.log(`Fanwan CLI — agent-first alert & memo platform.

Commands:
  health                                   Health check.
  add <content> [--at <ts>] [--channel <name>|--channel-id <id>] [--alert] [--tags <csv>]
  list [--status pending|triggered|done|cancelled|failed] [--upcoming] [--due] [--all] [--limit N]
  get <id>
  edit <id> [--content ...] [--at ...] [--channel ...] [--alert|--no-alert] [--status ...] [--tags ...]
  rm <id>
  trigger <id>                             Manually fire an entry's channel now.
  call <message> [--channel <name>|--channel-id <id>]
  channel list
  channel add phone <name> <webhook_url>
  channel rm <id>
  events [--entry <id>] [--limit N]

Server: ${BASE}`);
      return;
    }

    case "health": {
      print(await api("GET", "/health"));
      return;
    }

    case "add": {
      const content = args._[0];
      if (!content) { console.error("usage: fa add <content> [...]"); process.exit(2); }
      const body: any = { content };
      if (args.at) body.scheduled_at = String(args.at);
      if (args["channel-id"]) body.channel_id = Number(args["channel-id"]);
      if (args.channel) body.channel = String(args.channel);
      if (args.alert) body.alert = true;
      if (args.tags) body.tags = String(args.tags);
      const e = await api("POST", "/api/entries", body);
      console.error(fmtEntry(e));
      print(e);
      return;
    }

    case "list": {
      const params = new URLSearchParams();
      if (!args.all) params.set("status", String(args.status ?? "pending"));
      else if (args.status) params.set("status", String(args.status));
      if (args.upcoming) params.set("upcoming", "true");
      if (args.due) params.set("due", "true");
      if (args.limit) params.set("limit", String(args.limit));
      const r = await api("GET", `/api/entries?${params}`);
      for (const e of r.entries) console.error(fmtEntry(e));
      print(r);
      return;
    }

    case "get": {
      const id = args._[0];
      if (!id) { console.error("usage: fa get <id>"); process.exit(2); }
      const e = await api("GET", `/api/entries/${id}`);
      console.error(fmtEntry(e));
      print(e);
      return;
    }

    case "edit": {
      const id = args._[0];
      if (!id) { console.error("usage: fa edit <id> [...]"); process.exit(2); }
      const body: any = {};
      if (args.content) body.content = String(args.content);
      if (args.at !== undefined) body.scheduled_at = args.at === "null" || args.at === "" ? null : String(args.at);
      if (args.channel !== undefined) body.channel = args.channel === "null" ? null : String(args.channel);
      if (args["channel-id"] !== undefined) body.channel_id = args["channel-id"] === "null" ? null : Number(args["channel-id"]);
      if (args.alert) body.alert = true;
      if (args["no-alert"]) body.alert = false;
      if (args.status) body.status = String(args.status);
      if (args.tags !== undefined) body.tags = args.tags === "null" ? null : String(args.tags);
      const e = await api("PATCH", `/api/entries/${id}`, body);
      console.error(fmtEntry(e));
      print(e);
      return;
    }

    case "rm":
    case "delete": {
      const id = args._[0];
      if (!id) { console.error("usage: fa rm <id>"); process.exit(2); }
      print(await api("DELETE", `/api/entries/${id}`));
      return;
    }

    case "trigger": {
      const id = args._[0];
      if (!id) { console.error("usage: fa trigger <id>"); process.exit(2); }
      print(await api("POST", `/api/entries/${id}/trigger`));
      return;
    }

    case "call": {
      const message = args._[0];
      if (!message) { console.error("usage: fa call <message> [--channel <name>]"); process.exit(2); }
      const body: any = { message };
      if (args["channel-id"]) body.channel_id = Number(args["channel-id"]);
      if (args.channel) body.channel = String(args.channel);
      print(await api("POST", "/api/call", body));
      return;
    }

    case "channel": {
      const sub = args._[0];
      if (sub === "list") {
        const r = await api("GET", "/api/channels");
        for (const c of r.channels) console.error(`#${c.id} [${c.type}] ${c.name}`);
        print(r);
        return;
      }
      if (sub === "add") {
        const [, type, name, webhookUrl] = args._;
        if (type !== "phone" || !name || !webhookUrl) {
          console.error("usage: fa channel add phone <name> <webhook_url>");
          process.exit(2);
        }
        print(await api("POST", "/api/channels", { type, name, config: { webhook_url: webhookUrl } }));
        return;
      }
      if (sub === "rm" || sub === "delete") {
        const id = args._[1];
        if (!id) { console.error("usage: fa channel rm <id>"); process.exit(2); }
        print(await api("DELETE", `/api/channels/${id}`));
        return;
      }
      console.error("usage: fa channel <list|add|rm> ...");
      process.exit(2);
    }

    case "events": {
      const params = new URLSearchParams();
      if (args.entry) params.set("entry_id", String(args.entry));
      if (args.limit) params.set("limit", String(args.limit));
      print(await api("GET", `/api/events?${params}`));
      return;
    }

    default:
      console.error(`unknown command: ${cmd}. try \`fa help\`.`);
      process.exit(2);
  }
}

void main();
