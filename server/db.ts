import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { Channel, Entry, AlertEvent } from "../shared/types.ts";

const DB_PATH = resolve(process.cwd(), process.env.DB_PATH ?? "./data/fanwan.db");
mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA foreign_keys = ON;");

db.exec(`
CREATE TABLE IF NOT EXISTS channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  config TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  scheduled_at TEXT,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  alert INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending',
  tags TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_entries_due ON entries(status, scheduled_at) WHERE alert = 1;
CREATE INDEX IF NOT EXISTS idx_entries_status ON entries(status);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  entry_id INTEGER REFERENCES entries(id) ON DELETE SET NULL,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  status TEXT NOT NULL,
  response TEXT,
  triggered_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_entry ON events(entry_id);
`);

interface ChannelRow {
  id: number;
  type: string;
  name: string;
  config: string;
  created_at: string;
}

interface EntryRow {
  id: number;
  content: string;
  scheduled_at: string | null;
  channel_id: number | null;
  alert: number;
  status: string;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

interface EventRow {
  id: number;
  entry_id: number | null;
  channel_id: number;
  message: string;
  status: string;
  response: string | null;
  triggered_at: string;
}

function rowToChannel(r: ChannelRow): Channel {
  return { ...r, type: r.type as Channel["type"], config: JSON.parse(r.config) };
}

function rowToEntry(r: EntryRow): Entry {
  return {
    ...r,
    alert: !!r.alert,
    status: r.status as Entry["status"],
  };
}

function rowToEvent(r: EventRow): AlertEvent {
  return { ...r, status: r.status as AlertEvent["status"] };
}

// ---------- channels ----------

export const channelRepo = {
  list(): Channel[] {
    return db.query("SELECT * FROM channels ORDER BY id").all().map((r) => rowToChannel(r as ChannelRow));
  },
  get(id: number): Channel | null {
    const r = db.query("SELECT * FROM channels WHERE id = ?").get(id) as ChannelRow | null;
    return r ? rowToChannel(r) : null;
  },
  getByName(name: string): Channel | null {
    const r = db.query("SELECT * FROM channels WHERE name = ?").get(name) as ChannelRow | null;
    return r ? rowToChannel(r) : null;
  },
  create(input: { type: Channel["type"]; name: string; config: Record<string, unknown> }): Channel {
    const stmt = db.query(
      "INSERT INTO channels (type, name, config) VALUES (?, ?, ?) RETURNING *"
    );
    const r = stmt.get(input.type, input.name, JSON.stringify(input.config)) as ChannelRow;
    return rowToChannel(r);
  },
  remove(id: number): boolean {
    const info = db.run("DELETE FROM channels WHERE id = ?", [id]);
    return info.changes > 0;
  },
};

// ---------- entries ----------

export interface ListEntriesQuery {
  status?: Entry["status"];
  upcoming?: boolean;
  due?: boolean;
  limit?: number;
}

export const entryRepo = {
  list(q: ListEntriesQuery = {}): Entry[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.status) {
      where.push("status = ?");
      params.push(q.status);
    }
    if (q.upcoming) {
      where.push("scheduled_at IS NOT NULL AND scheduled_at >= datetime('now')");
    }
    if (q.due) {
      where.push("alert = 1 AND status = 'pending' AND scheduled_at IS NOT NULL AND scheduled_at <= datetime('now')");
    }
    const sql = `SELECT * FROM entries ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY COALESCE(scheduled_at, created_at) ASC LIMIT ?`;
    params.push(q.limit ?? 200);
    return db.query(sql).all(...(params as any[])).map((r) => rowToEntry(r as EntryRow));
  },
  get(id: number): Entry | null {
    const r = db.query("SELECT * FROM entries WHERE id = ?").get(id) as EntryRow | null;
    return r ? rowToEntry(r) : null;
  },
  create(input: {
    content: string;
    scheduled_at?: string | null;
    channel_id?: number | null;
    alert?: boolean;
    tags?: string | null;
  }): Entry {
    const r = db
      .query(
        `INSERT INTO entries (content, scheduled_at, channel_id, alert, tags)
         VALUES (?, ?, ?, ?, ?) RETURNING *`
      )
      .get(
        input.content,
        input.scheduled_at ?? null,
        input.channel_id ?? null,
        input.alert ? 1 : 0,
        input.tags ?? null
      ) as EntryRow;
    return rowToEntry(r);
  },
  update(id: number, patch: Partial<{
    content: string;
    scheduled_at: string | null;
    channel_id: number | null;
    alert: boolean;
    status: Entry["status"];
    tags: string | null;
  }>): Entry | null {
    const fields: string[] = [];
    const params: unknown[] = [];
    if (patch.content !== undefined) { fields.push("content = ?"); params.push(patch.content); }
    if (patch.scheduled_at !== undefined) { fields.push("scheduled_at = ?"); params.push(patch.scheduled_at); }
    if (patch.channel_id !== undefined) { fields.push("channel_id = ?"); params.push(patch.channel_id); }
    if (patch.alert !== undefined) { fields.push("alert = ?"); params.push(patch.alert ? 1 : 0); }
    if (patch.status !== undefined) { fields.push("status = ?"); params.push(patch.status); }
    if (patch.tags !== undefined) { fields.push("tags = ?"); params.push(patch.tags); }
    if (!fields.length) return this.get(id);
    fields.push("updated_at = datetime('now')");
    params.push(id);
    const r = db
      .query(`UPDATE entries SET ${fields.join(", ")} WHERE id = ? RETURNING *`)
      .get(...(params as any[])) as EntryRow | null;
    return r ? rowToEntry(r) : null;
  },
  remove(id: number): boolean {
    const info = db.run("DELETE FROM entries WHERE id = ?", [id]);
    return info.changes > 0;
  },
};

// ---------- events ----------

export const eventRepo = {
  list(filter: { entry_id?: number; limit?: number } = {}): AlertEvent[] {
    const where: string[] = [];
    const params: unknown[] = [];
    if (filter.entry_id !== undefined) {
      where.push("entry_id = ?");
      params.push(filter.entry_id);
    }
    params.push(filter.limit ?? 100);
    const sql = `SELECT * FROM events ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ?`;
    return db.query(sql).all(...(params as any[])).map((r) => rowToEvent(r as EventRow));
  },
  create(input: {
    entry_id: number | null;
    channel_id: number;
    message: string;
    status: AlertEvent["status"];
    response: string | null;
  }): AlertEvent {
    const r = db
      .query(
        `INSERT INTO events (entry_id, channel_id, message, status, response)
         VALUES (?, ?, ?, ?, ?) RETURNING *`
      )
      .get(input.entry_id, input.channel_id, input.message, input.status, input.response) as EventRow;
    return rowToEvent(r);
  },
};
