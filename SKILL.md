---
name: fanwan
description: >-
  Agent-first alert & memo platform. Use to schedule phone alerts, place
  immediate phone calls, and manage todos / memos as the agent's external memory.
  Triggers on: "提醒我", "电话告警", "phone alert", "remind me", "call me at",
  "schedule alert", "add memo", "待办", "备忘", "在 X 点叫我".
  Read INSTALL.md once (first time only) to install + start the service.
---

# Fanwan — agent CLI

A local SQLite-backed memo + alert scheduler. Each entry has `content`, optional
`scheduled_at`, optional `channel` (e.g. a phone alert webhook), and an
`alert` flag. The server scheduler fires alerts when due. Use it as the
agent's external memory and notification system.

> First-time setup (deps + .env + Next.js build + service start):
> see **[INSTALL.md](INSTALL.md)**. After that you only need this file.

## How to know it's running

```bash
bun run scripts/service.ts status      # ports + tmux session
bun run fa health                      # API ping
```

If `server.listening` is false, start it: `bun run scripts/service.ts start`.

If `start` fails or anything looks broken, run the diagnostic first:

```bash
bun run scripts/service.ts doctor      # checks bun/tmux/lsof/curl, deps, ports
```

Any ✗ comes with a `fix:` line. Only re-read `INSTALL.md` if doctor tells you
to reinstall, or on a fresh machine.

## The CLI

All operations go through one bun script. Use it instead of writing curl by hand.

```bash
bun run fa <command> [args...]
```

| Command | Purpose |
|---|---|
| `fa add "<content>" [--at "<ts>"] [--channel <name>] [--alert] [--tags csv]` | Create entry. `--alert` requires `--at` and `--channel`. |
| `fa list [--status pending\|triggered\|done\|cancelled\|failed] [--upcoming] [--due] [--all] [--limit N]` | List entries. Default = `--status pending`. |
| `fa get <id>` | Read one entry. |
| `fa edit <id> [--content ...] [--at ...] [--channel ...] [--alert\|--no-alert] [--status ...] [--tags ...]` | Patch fields. Pass `--at null` / `--channel null` / `--tags null` to clear. |
| `fa rm <id>` | Delete entry. |
| `fa trigger <id>` | Fire an entry's channel immediately (logged). |
| `fa call "<message>" [--channel <name>]` | Immediate phone call. Logged as an entry + event. Defaults to first phone channel. |
| `fa channel list` | List notification channels. |
| `fa channel add phone <name> <webhook_url>` | Add a phone channel (e.g. fwalert.com URL). |
| `fa channel rm <id>` | Delete a channel. |
| `fa events [--entry <id>] [--limit N]` | Audit log of alert deliveries. |

Service control (separate from the CLI):

| Command | Purpose |
|---|---|
| `bun run scripts/service.ts doctor` | Preflight: bun/tmux/lsof/curl, deps, ports. |
| `bun run scripts/service.ts install` | One-time deps install + Next.js build. |
| `bun run scripts/service.ts start \| stop \| restart \| status` | Process lifecycle. |
| `bun run scripts/service.ts logs api \| web` | `tail -f` the chosen log. |

JSON goes to stdout, a human summary to stderr. Pipe to `jq` for structured output.

## Time format contract (read carefully)

Mixing timezones silently is the #1 bug source for scheduled alerts. The
contract is intentionally explicit:

| Layer | Format |
|---|---|
| **SQLite storage** | UTC, `"YYYY-MM-DD HH:MM:SS"`. Never seen by clients. |
| **API request** (`POST/PATCH` body `scheduled_at`) | ISO 8601 string. **Always include a timezone designator** (`Z` or `±HH:MM`). If absent, the server treats it as UTC. |
| **API response** | ISO 8601 UTC with trailing `Z`, e.g. `"2026-05-20T07:00:00Z"`. Always UTC, always explicit. |
| **CLI `fa --at`** | Accepts any ISO string. If you pass a **bare** timestamp like `"2026-05-20 15:00"`, the CLI auto-appends `+08:00` (Asia/Shanghai) before sending. Override per-call by writing the suffix yourself, or globally with `FANWAN_DEFAULT_TZ`. |
| **CLI stderr summary** | Renders times in `FANWAN_DISPLAY_TZ` (default `Asia/Shanghai`), suffixed `+08`. JSON to stdout is still raw UTC. |
| **Web UI** | Both input and display are pinned to UTC+8 regardless of browser locale. The `datetime-local` field is interpreted as Shanghai wall-clock; displayed times have a `(UTC+8)` tag. |

### Examples

```bash
# bare → CLI normalizes to +08:00, stored as 2026-05-20 07:00:00 UTC
bun run fa add "下午 3 点会议" --at "2026-05-20 15:00" --channel default --alert

# explicit UTC
bun run fa add "0700 UTC ping" --at "2026-05-20T07:00:00Z" --channel default --alert

# explicit other zone (e.g. New York EDT)
bun run fa add "NY morning sync" --at "2026-05-20T09:00:00-04:00" --channel default --alert
```

After creation, the response always shows UTC:

```json
{ "scheduled_at": "2026-05-20T07:00:00Z", ... }
```

The web UI will render this row as `2026-05-20 15:00 (UTC+8)`.

### Rule of thumb for agents

- When the user says "下午 3 点" / "明天早上九点" / any local Chinese time → pass to `--at` as a bare string. The CLI handles +08:00.
- When the user gives explicit UTC or another zone → pass it verbatim with the suffix.
- Never construct timestamps by string-cat-ing fragments; let `Date()` or the CLI normalize.

## Common recipes

```bash
# 1) One-time channel setup (do once per webhook).
bun run fa channel add phone default https://fwalert.com/<uuid>

# 2) Schedule a phone alert.
bun run fa add "下午 3 点开会" --at "2026-05-20 15:00" --channel default --alert

# 3) Pure memo (no alert).
bun run fa add "记得问 boss 关于 Q3 OKR" --tags work

# 4) Immediate call (rate-limited to 60s per number by the provider).
bun run fa call "服务部署完成, 请检查"

# 5) Show what's coming up.
bun run fa list --upcoming

# 6) Mark done after handling.
bun run fa edit 7 --status done
```

## Constraints & gotchas

- **Phone rate limit**: the fwalert provider enforces a 60-second minimum
  interval per mobile target. If `events.status = "throttled"`, the entry is
  left as `pending` and the scheduler will retry on the next tick.
- **Channel deletion**: deleting a channel sets dependent entries'
  `channel_id` to NULL; they keep their content but stop alerting.
- **`alert=true` requires both** `scheduled_at` and a `channel_id`.
- **Secrets**: webhook URLs are stored in SQLite. The web UI hides them.
  Don't echo them to the user.
- **Service required**: the scheduler only fires while the bun server is up.
  Don't promise a future alert without `service.ts status` succeeding.

## Where things live

- Server (API + scheduler): `http://localhost:${SERVER_PORT}` (default `51737`)
- Web UI (human view):       `http://localhost:${WEB_PORT}` (set during install)
- SQLite DB: `./data/fanwan.db`
- Logs: `./logs/api.log`, `./logs/web.log` (or `tmux attach -t fanwan`)

## Stop / restart

```bash
bun run scripts/service.ts stop
bun run scripts/service.ts restart
bun run scripts/service.ts logs api      # tail -f
```

## HTTP API (only if you must bypass the CLI)

Base = `${API_BASE_URL}`. Auth via `Authorization: Bearer ${API_TOKEN}` (only if set).

```
GET    /health
GET    /api/channels
POST   /api/channels             { type:"phone", name, config:{webhook_url} }
DELETE /api/channels/:id
GET    /api/entries?status=&upcoming=&due=&limit=
POST   /api/entries              { content, scheduled_at?, channel_id? | channel?, alert?, tags? }
GET    /api/entries/:id
PATCH  /api/entries/:id          { ...partial }
DELETE /api/entries/:id
POST   /api/entries/:id/trigger
POST   /api/call                 { message, channel_id? | channel? }
GET    /api/events?entry_id=&limit=
```

Prefer the CLI. It loads `.env`, picks the right port, and formats errors.
