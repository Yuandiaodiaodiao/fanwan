import { channelRepo, entryRepo, eventRepo } from "./db.ts";
import { dispatch } from "./channels.ts";
import { triggerEntry, startScheduler } from "./scheduler.ts";

const PORT = Number(process.env.SERVER_PORT ?? 51737);
const TOKEN = process.env.API_TOKEN || null;
const TICK = Number(process.env.SCHEDULER_INTERVAL_MS ?? 15000);

function json(data: unknown, init: number | ResponseInit = 200): Response {
  return new Response(JSON.stringify(data), {
    ...(typeof init === "number" ? { status: init } : init),
    headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
  });
}

function err(status: number, message: string) {
  return json({ error: message }, status);
}

function authOk(req: Request): boolean {
  if (!TOKEN) return true;
  const h = req.headers.get("authorization");
  if (h?.startsWith("Bearer ") && h.slice(7) === TOKEN) return true;
  const url = new URL(req.url);
  return url.searchParams.get("token") === TOKEN;
}

async function readJson(req: Request): Promise<any> {
  try { return await req.json(); } catch { return {}; }
}

function parseIso(v: unknown): string | null {
  if (v == null || v === "") return null;
  if (typeof v !== "string") throw new Error("scheduled_at must be ISO string");
  const d = new Date(v);
  if (isNaN(d.getTime())) throw new Error(`invalid date: ${v}`);
  return d.toISOString().replace("T", " ").replace("Z", "").split(".")[0]; // sqlite-friendly UTC "YYYY-MM-DD HH:MM:SS"
}

const routes: Array<{
  method: string;
  pattern: RegExp;
  handler: (req: Request, m: RegExpMatchArray, url: URL) => Promise<Response> | Response;
}> = [];

function route(method: string, pattern: RegExp, handler: (req: Request, m: RegExpMatchArray, url: URL) => Promise<Response> | Response) {
  routes.push({ method, pattern, handler });
}

// ---------- health ----------

route("GET", /^\/health$/, () => json({ ok: true, service: "fanwan", time: new Date().toISOString() }));

// ---------- channels ----------

route("GET", /^\/api\/channels$/, () => json({ channels: channelRepo.list() }));

route("POST", /^\/api\/channels$/, async (req) => {
  const body = await readJson(req);
  if (!body.type || !body.name || !body.config) return err(400, "type, name, config required");
  if (body.type !== "phone") return err(400, "only type='phone' is supported");
  if (!body.config.webhook_url) return err(400, "config.webhook_url required for phone");
  try {
    const c = channelRepo.create({ type: body.type, name: body.name, config: body.config });
    return json(c, 201);
  } catch (e) {
    return err(400, (e as Error).message);
  }
});

route("DELETE", /^\/api\/channels\/(\d+)$/, (_req, m) => {
  return channelRepo.remove(Number(m[1])) ? json({ ok: true }) : err(404, "not found");
});

// ---------- entries ----------

route("GET", /^\/api\/entries$/, (_req, _m, url) => {
  const status = url.searchParams.get("status") ?? undefined;
  const upcoming = url.searchParams.get("upcoming") === "true";
  const due = url.searchParams.get("due") === "true";
  const limit = url.searchParams.get("limit") ? Number(url.searchParams.get("limit")) : undefined;
  return json({ entries: entryRepo.list({ status: status as any, upcoming, due, limit }) });
});

route("POST", /^\/api\/entries$/, async (req) => {
  const body = await readJson(req);
  if (!body.content || typeof body.content !== "string") return err(400, "content required");
  let scheduled_at: string | null = null;
  try { scheduled_at = parseIso(body.scheduled_at ?? null); }
  catch (e) { return err(400, (e as Error).message); }

  let channel_id: number | null = null;
  if (body.channel_id != null) channel_id = Number(body.channel_id);
  else if (body.channel) {
    const c = channelRepo.getByName(String(body.channel));
    if (!c) return err(400, `unknown channel name: ${body.channel}`);
    channel_id = c.id;
  }

  const alert = !!body.alert && channel_id != null && scheduled_at != null;
  if (body.alert && !alert) return err(400, "alert requires both channel_id/channel and scheduled_at");

  const e = entryRepo.create({
    content: body.content,
    scheduled_at,
    channel_id,
    alert,
    tags: body.tags ?? null,
  });
  return json(e, 201);
});

route("GET", /^\/api\/entries\/(\d+)$/, (_req, m) => {
  const e = entryRepo.get(Number(m[1]));
  return e ? json(e) : err(404, "not found");
});

route("PATCH", /^\/api\/entries\/(\d+)$/, async (req, m) => {
  const id = Number(m[1]);
  const body = await readJson(req);
  const patch: Parameters<typeof entryRepo.update>[1] = {};
  if (body.content !== undefined) patch.content = String(body.content);
  if (body.scheduled_at !== undefined) {
    try { patch.scheduled_at = parseIso(body.scheduled_at); }
    catch (e) { return err(400, (e as Error).message); }
  }
  if (body.channel_id !== undefined) patch.channel_id = body.channel_id == null ? null : Number(body.channel_id);
  if (body.channel !== undefined) {
    if (body.channel == null) patch.channel_id = null;
    else {
      const c = channelRepo.getByName(String(body.channel));
      if (!c) return err(400, `unknown channel name: ${body.channel}`);
      patch.channel_id = c.id;
    }
  }
  if (body.alert !== undefined) patch.alert = !!body.alert;
  if (body.status !== undefined) patch.status = body.status;
  if (body.tags !== undefined) patch.tags = body.tags;
  const updated = entryRepo.update(id, patch);
  return updated ? json(updated) : err(404, "not found");
});

route("DELETE", /^\/api\/entries\/(\d+)$/, (_req, m) => {
  return entryRepo.remove(Number(m[1])) ? json({ ok: true }) : err(404, "not found");
});

route("POST", /^\/api\/entries\/(\d+)\/trigger$/, async (_req, m) => {
  const r = await triggerEntry(Number(m[1]));
  return r.ok ? json(r) : err(400, r.error ?? "trigger failed");
});

// ---------- immediate call ----------

route("POST", /^\/api\/call$/, async (req) => {
  const body = await readJson(req);
  if (!body.message || typeof body.message !== "string") return err(400, "message required");

  let channel = null;
  if (body.channel_id != null) channel = channelRepo.get(Number(body.channel_id));
  else if (body.channel) channel = channelRepo.getByName(String(body.channel));
  else {
    const all = channelRepo.list().filter((c) => c.type === "phone");
    channel = all[0] ?? null;
  }
  if (!channel) return err(400, "no phone channel configured. Add one via POST /api/channels");

  // Persist as triggered entry for traceability.
  const entry = entryRepo.create({
    content: body.message,
    scheduled_at: null,
    channel_id: channel.id,
    alert: false,
    tags: "immediate-call",
  });
  const result = await dispatch(channel, body.message);
  const event = eventRepo.create({
    entry_id: entry.id,
    channel_id: channel.id,
    message: body.message,
    status: result.status,
    response: result.response,
  });
  entryRepo.update(entry.id, {
    status: result.status === "ok" ? "triggered" : result.status === "throttled" ? "pending" : "failed",
  });
  return json({ entry, event }, result.status === "ok" ? 200 : 202);
});

// ---------- events ----------

route("GET", /^\/api\/events$/, (_req, _m, url) => {
  const entry_id = url.searchParams.get("entry_id");
  const limit = url.searchParams.get("limit");
  return json({
    events: eventRepo.list({
      entry_id: entry_id ? Number(entry_id) : undefined,
      limit: limit ? Number(limit) : undefined,
    }),
  });
});

// ---------- server ----------

const server = Bun.serve({
  port: PORT,
  async fetch(req) {
    if (req.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
          "access-control-allow-headers": "content-type,authorization",
        },
      });
    }
    const url = new URL(req.url);
    if (url.pathname !== "/health" && !authOk(req)) return err(401, "unauthorized");
    for (const r of routes) {
      if (r.method !== req.method) continue;
      const m = url.pathname.match(r.pattern);
      if (m) {
        try {
          return await r.handler(req, m, url);
        } catch (e) {
          console.error("[handler error]", e);
          return err(500, (e as Error).message);
        }
      }
    }
    return err(404, `no route: ${req.method} ${url.pathname}`);
  },
});

startScheduler(TICK);
console.log(`[fanwan] api listening on http://localhost:${server.port}`);
console.log(`[fanwan] db: ${process.env.DB_PATH ?? "./data/fanwan.db"}  token: ${TOKEN ? "set" : "none"}`);
