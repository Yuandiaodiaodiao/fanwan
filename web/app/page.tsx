"use client";

import { useEffect, useState, useCallback } from "react";

type Channel = { id: number; type: string; name: string; config: Record<string, unknown> };
type Entry = {
  id: number;
  content: string;
  scheduled_at: string | null;
  channel_id: number | null;
  alert: boolean;
  status: "pending" | "triggered" | "done" | "cancelled" | "failed";
  tags: string | null;
  created_at: string;
  updated_at: string;
};

const API = process.env.NEXT_PUBLIC_API_BASE ?? "/proxy";

const STATUS_CN: Record<Entry["status"], string> = {
  pending: "待办",
  triggered: "已触发",
  done: "已完成",
  cancelled: "已取消",
  failed: "失败",
};

async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body == null ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(await res.text());
  return res.json() as Promise<T>;
}

function toIsoLocal(input: string): string {
  // datetime-local gives "YYYY-MM-DDTHH:mm"; treat as local and convert to ISO UTC.
  if (!input) return "";
  return new Date(input).toISOString();
}

export default function Home() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [filter, setFilter] = useState<"pending" | "triggered" | "done" | "all">("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // form
  const [content, setContent] = useState("");
  const [at, setAt] = useState("");
  const [channelId, setChannelId] = useState<string>("");
  const [alertOn, setAlertOn] = useState(false);

  // channel form
  const [chanName, setChanName] = useState("");
  const [chanUrl, setChanUrl] = useState("");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const q = filter === "all" ? "" : `?status=${filter}`;
      const [e, c] = await Promise.all([
        api<{ entries: Entry[] }>("GET", `/api/entries${q}`),
        api<{ channels: Channel[] }>("GET", "/api/channels"),
      ]);
      setEntries(e.entries);
      setChannels(c.channels);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [refresh]);

  async function addEntry(e: React.FormEvent) {
    e.preventDefault();
    if (!content.trim()) return;
    try {
      await api("POST", "/api/entries", {
        content,
        scheduled_at: at ? toIsoLocal(at) : null,
        channel_id: channelId ? Number(channelId) : null,
        alert: alertOn,
      });
      setContent(""); setAt(""); setAlertOn(false);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function removeEntry(id: number) {
    await api("DELETE", `/api/entries/${id}`);
    await refresh();
  }

  async function setStatus(id: number, status: Entry["status"]) {
    await api("PATCH", `/api/entries/${id}`, { status });
    await refresh();
  }

  async function triggerNow(id: number) {
    try {
      await api("POST", `/api/entries/${id}/trigger`);
    } catch (err) {
      setError((err as Error).message);
    }
    await refresh();
  }

  async function addChannel(e: React.FormEvent) {
    e.preventDefault();
    if (!chanName.trim() || !chanUrl.trim()) return;
    try {
      await api("POST", "/api/channels", {
        type: "phone", name: chanName, config: { webhook_url: chanUrl },
      });
      setChanName(""); setChanUrl("");
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function deleteChannel(id: number) {
    await api("DELETE", `/api/channels/${id}`);
    await refresh();
  }

  const channelById = (id: number | null) => channels.find((c) => c.id === id);

  return (
    <div className="grid">
      <div>
        <div className="panel">
          <h2>新建条目</h2>
          <form onSubmit={addEntry}>
            <div className="field">
              <label>内容</label>
              <textarea value={content} onChange={(e) => setContent(e.target.value)} placeholder="要记录或提醒的事情…" />
            </div>
            <div className="row">
              <div className="field" style={{ flex: 2 }}>
                <label>时间（可选）</label>
                <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} />
              </div>
              <div className="field" style={{ flex: 1 }}>
                <label>渠道</label>
                <select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                  <option value="">（不选 — 仅备忘）</option>
                  {channels.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
              <div className="field" style={{ alignSelf: "end" }}>
                <label>&nbsp;</label>
                <label style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text)" }}>
                  <input type="checkbox" checked={alertOn} onChange={(e) => setAlertOn(e.target.checked)} />
                  到点告警
                </label>
              </div>
            </div>
            <button type="submit">添加</button>
          </form>
        </div>

        <div className="panel">
          <div className="toolbar">
            <h2 style={{ margin: 0, flex: 1 }}>条目列表</h2>
            <select value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="pending">待办</option>
              <option value="triggered">已触发</option>
              <option value="done">已完成</option>
              <option value="all">全部</option>
            </select>
            <button className="secondary" onClick={() => void refresh()}>刷新</button>
          </div>
          {error && <div className="empty" style={{ color: "var(--danger)" }}>{error}</div>}
          {loading && entries.length === 0 ? (
            <div className="empty">加载中…</div>
          ) : entries.length === 0 ? (
            <div className="empty">暂无条目。</div>
          ) : (
            <ul className="entries">
              {entries.map((e) => {
                const ch = channelById(e.channel_id);
                return (
                  <li key={e.id}>
                    <span className={"bell " + (e.alert ? "on" : "off")} title={e.alert ? "到点会告警" : "仅备忘"}>
                      {e.alert ? "🔔" : "·"}
                    </span>
                    <div>
                      <div className="entry-content">{e.content}</div>
                      <div className="entry-meta">
                        <span className={`status ${e.status}`}>{STATUS_CN[e.status]}</span>
                        {" · "}
                        {e.scheduled_at ? <>时间 <b>{e.scheduled_at}</b> UTC</> : "无时间"}
                        {ch ? <> · 渠道 <b>{ch.name}</b></> : ""}
                        {e.tags ? <> · <i>{e.tags}</i></> : ""}
                      </div>
                    </div>
                    <div className="row" style={{ justifyContent: "flex-end" }}>
                      {e.channel_id != null && (
                        <button className="secondary" onClick={() => void triggerNow(e.id)} title="立即触发该条告警">立即拨打</button>
                      )}
                      {e.status !== "done" && (
                        <button className="secondary" onClick={() => void setStatus(e.id, "done")}>标记完成</button>
                      )}
                      <button className="danger" onClick={() => void removeEntry(e.id)}>删除</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <div>
        <div className="panel">
          <h2>告警渠道</h2>
          {channels.length === 0 ? (
            <div className="empty">还没有渠道，请在下方添加。</div>
          ) : (
            <ul className="entries">
              {channels.map((c) => (
                <li key={c.id}>
                  <span className="bell on">{c.type === "phone" ? "📞" : "📡"}</span>
                  <div>
                    <div className="entry-content">{c.name}</div>
                    <div className="entry-meta">{c.type === "phone" ? "电话告警" : c.type} · webhook 已隐藏</div>
                  </div>
                  <button className="danger" onClick={() => void deleteChannel(c.id)}>删除</button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={addChannel} style={{ marginTop: 12 }}>
            <div className="field">
              <label>渠道名称</label>
              <input type="text" value={chanName} onChange={(e) => setChanName(e.target.value)} placeholder="default" />
            </div>
            <div className="field">
              <label>电话告警 Webhook URL（例如 https://fwalert.com/…）</label>
              <input type="text" value={chanUrl} onChange={(e) => setChanUrl(e.target.value)} placeholder="https://fwalert.com/…" />
            </div>
            <button type="submit">添加电话渠道</button>
          </form>
        </div>

        <div className="panel">
          <h2>Agent 用法</h2>
          <p style={{ color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>
            Agent 通过 CLI 操作：<span className="kbd">bun run fa add &quot;…&quot; --at … --channel default --alert</span>，
            {" "}<span className="kbd">fa list</span>，<span className="kbd">fa call &quot;…&quot;</span>。
            完整语法见仓库根目录的 <span className="kbd">SKILL.md</span>。
          </p>
        </div>
      </div>
    </div>
  );
}
