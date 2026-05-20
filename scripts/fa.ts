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

/**
 * Default timezone for naive timestamps passed via --at.
 * Fanwan assumes the user / agent is in UTC+8 (Asia/Shanghai). To send a
 * different zone, pass an explicit offset, e.g.
 *   --at "2026-05-20T15:00:00Z"        (UTC)
 *   --at "2026-05-20T08:00:00-05:00"   (Eastern Time)
 */
const DEFAULT_TZ_OFFSET = process.env.FANWAN_DEFAULT_TZ ?? "+08:00";

/**
 * Normalize an `--at` value so the server receives an unambiguous ISO 8601
 * string. If the user already wrote a Z or ±HH:MM suffix we keep it.
 * Otherwise the bare string is treated as DEFAULT_TZ_OFFSET local time.
 */
function normalizeTs(input: string): string {
  if (/Z$/i.test(input) || /[+-]\d{2}:?\d{2}$/.test(input)) return input;
  const s = input.includes("T") ? input : input.replace(" ", "T");
  return `${s}${DEFAULT_TZ_OFFSET}`;
}

/**
 * Lenient natural-time parser for the `remind` shortcut. Returns an ISO 8601
 * UTC string. Throws on unparsable input. Supported shapes:
 *
 *   HH:MM                 → today at HH:MM in DEFAULT_TZ_OFFSET (rolls to tomorrow if in the past)
 *   +30m / +2h / +45s     → relative to now
 *   今天 HH:MM / today HH:MM
 *   明天 HH:MM / tomorrow HH:MM
 *   YYYY-MM-DD HH:MM      → bare, treated as DEFAULT_TZ_OFFSET
 *   <full ISO 8601>       → passed through
 */
function parseRemindTime(input: string, now: Date = new Date()): string {
  const s = input.trim();

  // Full ISO 8601 with timezone
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})$/.test(s)) {
    const d = new Date(s);
    if (isNaN(d.getTime())) throw new Error(`invalid ISO 8601: ${s}`);
    return d.toISOString();
  }

  // Relative: +30m / +2h / +45s / +1d
  const rel = s.match(/^\+(\d+)\s*(s|sec|m|min|h|hr|d)$/i);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2].toLowerCase();
    const ms = unit.startsWith("s") ? n * 1000
             : unit.startsWith("m") ? n * 60_000
             : unit.startsWith("h") ? n * 3_600_000
             : n * 86_400_000;
    return new Date(now.getTime() + ms).toISOString();
  }

  // 今天/today/明天/tomorrow + HH:MM
  const wordRel = s.match(/^(今天|today|明天|tomorrow)\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/i);
  if (wordRel) {
    const offsetDays = /明天|tomorrow/i.test(wordRel[1]) ? 1 : 0;
    return buildShanghai(now, offsetDays, Number(wordRel[2]), Number(wordRel[3]), Number(wordRel[4] ?? 0));
  }

  // Pure HH:MM today (rolls forward if past)
  const hm = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (hm) {
    let iso = buildShanghai(now, 0, Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0));
    if (new Date(iso).getTime() <= now.getTime()) {
      iso = buildShanghai(now, 1, Number(hm[1]), Number(hm[2]), Number(hm[3] ?? 0));
    }
    return iso;
  }

  // Bare date or date-time: treat as DEFAULT_TZ_OFFSET
  const d = new Date(normalizeTs(s));
  if (isNaN(d.getTime())) throw new Error(`cannot parse time: "${s}"`);
  return d.toISOString();
}

function buildShanghai(now: Date, dayOffset: number, h: number, m: number, sec: number): string {
  // Today's date string *in Shanghai*.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(now).reduce<Record<string, string>>((a, p) => (a[p.type] = p.value, a), {});
  // Shift the day in Shanghai (via UTC-noon trick: noon UTC is mid-day everywhere, no DST in Shanghai).
  const shifted = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day) + dayOffset));
  const y = shifted.getUTCFullYear();
  const mo = String(shifted.getUTCMonth() + 1).padStart(2, "0");
  const d = String(shifted.getUTCDate()).padStart(2, "0");
  return new Date(`${y}-${mo}-${d}T${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(sec).padStart(2,"0")}+08:00`).toISOString();
}

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

/**
 * Like `api` but never `process.exit`s — returns a discriminated result so
 * higher-level commands (like `remind`) can build a stable JSON envelope.
 */
async function apiSafe(method: string, path: string, body?: unknown): Promise<
  { ok: true; data: any } | { ok: false; status: number; error: string; remedy?: string }
> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (TOKEN) headers.authorization = `Bearer ${TOKEN}`;
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, { method, headers, body: body == null ? undefined : JSON.stringify(body) });
  } catch (e) {
    return { ok: false, status: 0, error: `cannot reach ${BASE}: ${(e as Error).message}`,
             remedy: "bun run scripts/service.ts start" };
  }
  const text = await res.text();
  let data: any = text;
  try { data = JSON.parse(text); } catch {}
  if (!res.ok) {
    const msg = typeof data === "string" ? data : data?.error ?? text;
    return { ok: false, status: res.status, error: msg };
  }
  return { ok: true, data };
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

const DISPLAY_TZ = process.env.FANWAN_DISPLAY_TZ ?? "Asia/Shanghai";
function fmtTs(iso: string | null): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const parts = new Intl.DateTimeFormat("zh-CN", {
      timeZone: DISPLAY_TZ, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d).reduce<Record<string, string>>((acc, p) => (acc[p.type] = p.value, acc), {});
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} +08`;
  } catch { return iso; }
}
function fmtEntry(e: any): string {
  const ring = e.alert ? "🔔" : "·";
  return `#${e.id} [${e.status}] ${ring} ${fmtTs(e.scheduled_at)}  ${e.content}`;
}

type RemindOk = {
  ok: true;
  action: "remind";
  entry: any;
  channel: { id: number; name: string; type: string };
  scheduled_in_seconds: number;
  display: { local: string; utc: string; tz: string };
};
type RemindErr = {
  ok: false;
  action: "remind";
  error_code:
    | "missing_content" | "missing_at" | "bad_time" | "past_time"
    | "server_down" | "no_channel" | "unknown_channel" | "create_failed" | "read_failed";
  error: string;
  remedy?: string;
};

async function doRemind(args: Flags): Promise<RemindOk | RemindErr> {
  const content = args._[0];
  if (!content || typeof content !== "string") {
    return { ok: false, action: "remind", error_code: "missing_content",
             error: "usage: fa remind <content> --at <time> [--channel <name>]" };
  }
  if (!args.at) {
    return { ok: false, action: "remind", error_code: "missing_at",
             error: "missing --at <time>",
             remedy: 'examples: --at "16:55"   --at "+30m"   --at "明天 09:00"' };
  }

  // 1. parse time
  let isoUtc: string;
  try { isoUtc = parseRemindTime(String(args.at)); }
  catch (e) {
    return { ok: false, action: "remind", error_code: "bad_time",
             error: (e as Error).message,
             remedy: 'try "16:55", "+30m", "明天 09:00", or full ISO 8601 with TZ' };
  }

  // 2. reject past
  const target = new Date(isoUtc);
  const now = new Date();
  const deltaSec = Math.round((target.getTime() - now.getTime()) / 1000);
  if (deltaSec <= 0) {
    return { ok: false, action: "remind", error_code: "past_time",
             error: `time ${isoUtc} is ${-deltaSec}s in the past`,
             remedy: "use a future time, or relative like +5m / +1h" };
  }

  // 3. server health
  const h = await apiSafe("GET", "/health");
  if (!h.ok) {
    return { ok: false, action: "remind", error_code: "server_down",
             error: h.error, remedy: h.remedy ?? "bun run scripts/service.ts start" };
  }

  // 4. resolve channel
  const channels = await apiSafe("GET", "/api/channels");
  if (!channels.ok) return { ok: false, action: "remind", error_code: "server_down", error: channels.error };
  const list: any[] = channels.data.channels ?? [];
  let channel: any;
  if (args.channel) {
    channel = list.find((c) => c.name === String(args.channel));
    if (!channel) {
      return { ok: false, action: "remind", error_code: "unknown_channel",
               error: `no channel named "${args.channel}"`,
               remedy: `available: ${list.map((c) => c.name).join(", ") || "(none)"} — add with: fa channel add phone <name> <webhook_url>` };
    }
  } else {
    channel = list.find((c) => c.type === "phone");
    if (!channel) {
      return { ok: false, action: "remind", error_code: "no_channel",
               error: "no phone channel configured",
               remedy: "fa channel add phone default <webhook_url>" };
    }
  }

  // 5. create
  const created = await apiSafe("POST", "/api/entries", {
    content, scheduled_at: isoUtc, channel_id: channel.id, alert: true,
    tags: args.tags ? String(args.tags) : null,
  });
  if (!created.ok) {
    return { ok: false, action: "remind", error_code: "create_failed", error: created.error };
  }

  // 6. read back
  const readback = await apiSafe("GET", `/api/entries/${created.data.id}`);
  if (!readback.ok) {
    return { ok: false, action: "remind", error_code: "read_failed", error: readback.error };
  }

  // 7. stable output
  const localStr = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(target).reduce<Record<string, string>>((a, p) => (a[p.type] = p.value, a), {});

  return {
    ok: true,
    action: "remind",
    entry: readback.data,
    channel: { id: channel.id, name: channel.name, type: channel.type },
    scheduled_in_seconds: deltaSec,
    display: {
      local: `${localStr.year}-${localStr.month}-${localStr.day} ${localStr.hour}:${localStr.minute}`,
      utc: isoUtc,
      tz: "Asia/Shanghai",
    },
  };
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

High-level (recommended for agents):
  remind <content> --at <time> [--channel <name>] [--tags <csv>]
        Safe pipeline: parse time → reject past → ping → resolve channel
        → create → read back → emit stable JSON. <time> accepts:
            HH:MM                  → today (rolls to tomorrow if past)
            +30m / +2h / +45s      → relative
            今天 09:00 / today 09:00
            明天 09:00 / tomorrow 09:00
            "YYYY-MM-DD HH:MM"     → bare, treated as UTC+8
            ISO 8601 with TZ       → passed through

Low-level:
  health
  add <content> [--at <ts>] [--channel <name>|--channel-id <id>] [--alert] [--tags <csv>]
  list [--status pending|triggered|done|cancelled|failed] [--upcoming] [--due] [--all] [--limit N]
  get <id>
  edit <id> [--content ...] [--at ...] [--channel ...] [--alert|--no-alert] [--status ...] [--tags ...]
  rm <id>
  trigger <id>
  call <message> [--channel <name>|--channel-id <id>]
  channel list
  channel add phone <name> <webhook_url>
  channel rm <id>
  events [--entry <id>] [--limit N]

Server: ${BASE}`);
      return;
    }

    case "remind": {
      const result = await doRemind(args);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      if (!result.ok) process.exit(1);
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
      if (args.at) body.scheduled_at = normalizeTs(String(args.at));
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
      if (args.at !== undefined) body.scheduled_at = args.at === "null" || args.at === "" ? null : normalizeTs(String(args.at));
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
