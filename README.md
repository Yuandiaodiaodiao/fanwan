# Fanwan

> Agent-first alert & memo platform — scheduled phone calls, todos, and external
> memory for AI agents, with a Next.js UI for humans.

Think of it as a **calendar app built for an AI assistant**: agents read
`SKILL.md`, then drive the system via a single bun CLI (`fa`). Humans get a
local Next.js dashboard to see and edit the same data.

## Quick start

```bash
bun run scripts/service.ts install     # one-time
bun run scripts/service.ts start       # tmux session: api + web
bun run fa channel add phone default https://fwalert.com/<uuid>
bun run fa call "hello from fanwan"    # phone rings
```

See **[INSTALL.md](INSTALL.md)** for first-time setup and
**[SKILL.md](SKILL.md)** for the full CLI / API.

## Architecture

```
┌──────────────┐    fa CLI (bun)    ┌────────────────────┐
│  AI Agent    │ ─────────────────▶ │  fanwan server     │
└──────────────┘                    │  Bun.serve + tick  │
                                    │  bun:sqlite        │
┌──────────────┐    HTTP /api/*     │                    │
│  Next.js UI  │ ─────────────────▶ │  channels.dispatch │
│ (browser)    │                    └─────────┬──────────┘
└──────────────┘                              ▼
                                      phone webhook (fwalert.com)
```

- **server/** — Bun HTTP API + scheduler tick + SQLite repo.
- **scripts/fa.ts** — agent CLI (single dispatcher).
- **scripts/service.ts** — install / start / stop / status / logs.
- **web/** — Next.js 16 dashboard.
- **shared/** — types shared between server and clients.

## Tech

bun · TypeScript · `bun:sqlite` · Next.js 16 · zero non-essential deps.
