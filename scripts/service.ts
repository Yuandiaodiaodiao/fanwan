#!/usr/bin/env bun
/**
 * Service control for the fanwan platform.
 *
 *   bun run scripts/service.ts install     # one-shot: deps + .env + web build
 *   bun run scripts/service.ts start       # start server + web in tmux session "fanwan"
 *   bun run scripts/service.ts stop        # kill the tmux session
 *   bun run scripts/service.ts status      # whether the session and ports are alive
 *   bun run scripts/service.ts logs [api|web]
 *
 * tmux is preferred (panes survive the agent session); falls back to nohup.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, appendFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = resolve(import.meta.dir, "..");
const ENV = join(ROOT, ".env");
const ENV_EXAMPLE = join(ROOT, ".env.example");
const LOG_DIR = join(ROOT, "logs");
const SESSION = "fanwan";

function sh(cmd: string, args: string[], opts: { cwd?: string; env?: NodeJS.ProcessEnv } = {}) {
  const r = spawnSync(cmd, args, {
    cwd: opts.cwd ?? ROOT,
    env: { ...process.env, ...(opts.env ?? {}) },
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(`[service] command failed: ${cmd} ${args.join(" ")}`);
    process.exit(r.status ?? 1);
  }
}

function shOut(cmd: string, args: string[]): { code: number; out: string } {
  const r = spawnSync(cmd, args, { cwd: ROOT });
  return { code: r.status ?? 1, out: (r.stdout?.toString() ?? "") + (r.stderr?.toString() ?? "") };
}

function loadDotenv(): Record<string, string> {
  if (!existsSync(ENV)) return {};
  const m: Record<string, string> = {};
  for (const line of readFileSync(ENV, "utf8").split("\n")) {
    const x = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (x) m[x[1]] = x[2].replace(/^['"]|['"]$/g, "");
  }
  return m;
}

function ensureEnv() {
  if (!existsSync(ENV)) {
    copyFileSync(ENV_EXAMPLE, ENV);
    console.log("[service] created .env from .env.example — edit it to set ports/token.");
  }
}

function hasTmux(): boolean {
  return shOut("which", ["tmux"]).code === 0;
}

function tmuxSessionExists(): boolean {
  return shOut("tmux", ["has-session", "-t", SESSION]).code === 0;
}

function portInUse(port: number): boolean {
  const r = shOut("lsof", ["-iTCP:" + port, "-sTCP:LISTEN", "-Pn"]);
  return r.code === 0 && r.out.includes("LISTEN");
}

// ---------- commands ----------

async function cmdInstall() {
  ensureEnv();
  mkdirSync(LOG_DIR, { recursive: true });
  mkdirSync(join(ROOT, "data"), { recursive: true });

  console.log("[service] installing root deps…");
  sh("bun", ["install"]);

  if (existsSync(join(ROOT, "web", "package.json"))) {
    console.log("[service] installing web deps…");
    sh("bun", ["install"], { cwd: join(ROOT, "web") });
    console.log("[service] building Next.js (production)…");
    const envForBuild = { ...process.env, ...loadDotenv() };
    sh("bun", ["run", "build"], { cwd: join(ROOT, "web"), env: envForBuild });
  }

  console.log("[service] install complete. Next: `bun run scripts/service.ts start`");
}

async function cmdStart() {
  ensureEnv();
  mkdirSync(LOG_DIR, { recursive: true });
  const env = loadDotenv();
  const port = Number(env.SERVER_PORT ?? 51737);
  const webPort = Number(env.WEB_PORT ?? 51738);

  if (!existsSync(join(ROOT, "node_modules"))) {
    console.error("[service] root node_modules missing — run `bun run scripts/service.ts install` first.");
    process.exit(1);
  }
  if (!existsSync(join(ROOT, "web", "node_modules"))) {
    console.error("[service] web/node_modules missing — run `bun run scripts/service.ts install` first.");
    process.exit(1);
  }
  if (!existsSync(join(ROOT, "web", ".next"))) {
    console.error("[service] web/.next build missing — run `bun run scripts/service.ts install` first.");
    process.exit(1);
  }

  if (portInUse(port)) {
    console.error(`[service] port ${port} (server) already in use — abort.`);
    process.exit(1);
  }
  if (portInUse(webPort)) {
    console.error(`[service] port ${webPort} (web) already in use — abort.`);
    process.exit(1);
  }

  if (hasTmux()) {
    if (tmuxSessionExists()) {
      console.log("[service] tmux session 'fanwan' already running. Use `stop` first.");
      process.exit(1);
    }
    const apiLog = join(LOG_DIR, "api.log");
    const webLog = join(LOG_DIR, "web.log");
    appendFileSync(apiLog, `\n--- start ${new Date().toISOString()} ---\n`);
    appendFileSync(webLog, `\n--- start ${new Date().toISOString()} ---\n`);

    sh("tmux", ["new-session", "-d", "-s", SESSION, "-n", "api",
      `cd ${ROOT} && bun run server 2>&1 | tee -a ${apiLog}`]);
    sh("tmux", ["new-window", "-t", `${SESSION}:`, "-n", "web",
      `cd ${ROOT}/web && PORT=${webPort} bun run start 2>&1 | tee -a ${webLog}`]);

    console.log(`[service] started in tmux session 'fanwan'.`);
    console.log(`  api: http://localhost:${port}    log: ${apiLog}`);
    console.log(`  web: http://localhost:${webPort}    log: ${webLog}`);
    console.log(`  attach: tmux attach -t fanwan`);
  } else {
    console.log("[service] tmux not found — falling back to nohup.");
    const apiLog = join(LOG_DIR, "api.log");
    const webLog = join(LOG_DIR, "web.log");
    sh("bash", ["-c", `nohup bun run server >>${apiLog} 2>&1 & echo $! > ${LOG_DIR}/api.pid`]);
    sh("bash", ["-c", `cd web && nohup env PORT=${webPort} bun run start >>${webLog} 2>&1 & echo $! > ${LOG_DIR}/web.pid`]);
    console.log(`[service] started via nohup. PIDs in ${LOG_DIR}/{api,web}.pid`);
  }
}

async function cmdStop() {
  if (hasTmux() && tmuxSessionExists()) {
    sh("tmux", ["kill-session", "-t", SESSION]);
    console.log("[service] tmux session 'fanwan' killed.");
    return;
  }
  for (const name of ["api", "web"]) {
    const pidFile = join(LOG_DIR, `${name}.pid`);
    if (existsSync(pidFile)) {
      const pid = readFileSync(pidFile, "utf8").trim();
      if (pid) shOut("kill", [pid]);
      writeFileSync(pidFile, "");
      console.log(`[service] killed ${name} (pid ${pid}).`);
    }
  }
}

async function cmdStatus() {
  const env = loadDotenv();
  const port = Number(env.SERVER_PORT ?? 51737);
  const webPort = Number(env.WEB_PORT ?? 51738);
  const tmuxAlive = hasTmux() && tmuxSessionExists();
  console.log(JSON.stringify({
    tmux_session: tmuxAlive,
    server: { port, listening: portInUse(port) },
    web: { port: webPort, listening: portInUse(webPort) },
    env_file: existsSync(ENV),
  }, null, 2));
}

async function cmdLogs() {
  const which = process.argv[3] ?? "api";
  const path = join(LOG_DIR, `${which}.log`);
  if (!existsSync(path)) { console.error(`no log at ${path}`); process.exit(1); }
  sh("tail", ["-n", "200", "-f", path]);
}

async function cmdDoctor() {
  const checks: Array<{ name: string; ok: boolean; detail: string; fix?: string }> = [];

  // bun
  {
    const r = shOut("bun", ["--version"]);
    checks.push({
      name: "bun",
      ok: r.code === 0,
      detail: r.code === 0 ? r.out.trim() : "not found",
      fix: 'install via:  curl -fsSL https://bun.sh/install | bash   (then restart shell)',
    });
  }
  // tmux (optional but recommended)
  {
    const r = shOut("tmux", ["-V"]);
    checks.push({
      name: "tmux (recommended)",
      ok: r.code === 0,
      detail: r.code === 0 ? r.out.trim() : "not found — will fall back to nohup",
      fix: 'macOS:  brew install tmux        Debian/Ubuntu:  sudo apt install tmux',
    });
  }
  // lsof for port checks
  {
    const r = shOut("lsof", ["-v"]);
    checks.push({
      name: "lsof",
      ok: r.code === 0 || r.code === 1, // lsof -v can return 1 but is installed
      detail: r.code === 0 || r.code === 1 ? "ok" : "not found",
      fix: 'macOS: pre-installed.   Debian/Ubuntu:  sudo apt install lsof',
    });
  }
  // curl (for testing the API)
  {
    const r = shOut("curl", ["--version"]);
    checks.push({ name: "curl", ok: r.code === 0, detail: r.code === 0 ? r.out.split("\n")[0] : "not found",
      fix: 'macOS: pre-installed.   Debian/Ubuntu:  sudo apt install curl' });
  }
  // .env
  checks.push({ name: ".env present", ok: existsSync(ENV), detail: existsSync(ENV) ? ENV : "missing",
    fix: 'cp .env.example .env  (then edit ports)' });
  // node_modules
  checks.push({ name: "root node_modules", ok: existsSync(join(ROOT, "node_modules")),
    detail: existsSync(join(ROOT, "node_modules")) ? "ok" : "missing",
    fix: 'bun install' });
  checks.push({ name: "web node_modules", ok: existsSync(join(ROOT, "web", "node_modules")),
    detail: existsSync(join(ROOT, "web", "node_modules")) ? "ok" : "missing",
    fix: 'cd web && bun install' });
  checks.push({ name: "web build (.next)", ok: existsSync(join(ROOT, "web", ".next")),
    detail: existsSync(join(ROOT, "web", ".next")) ? "ok" : "missing",
    fix: 'cd web && bun run build' });
  // ports
  if (existsSync(ENV)) {
    const env = loadDotenv();
    const port = Number(env.SERVER_PORT ?? 51737);
    const webPort = Number(env.WEB_PORT ?? 51738);
    const ours = hasTmux() && tmuxSessionExists();
    const portState = (p: number) => {
      if (!portInUse(p)) return { ok: true, detail: "free" };
      if (ours) return { ok: true, detail: "in use by fanwan (already running)" };
      return { ok: false, detail: "in use by another process" };
    };
    const s1 = portState(port);
    const s2 = portState(webPort);
    checks.push({ name: `SERVER_PORT ${port}`, ok: s1.ok, detail: s1.detail,
      fix: `change SERVER_PORT in .env, or  lsof -iTCP:${port} -sTCP:LISTEN -Pn` });
    checks.push({ name: `WEB_PORT ${webPort}`, ok: s2.ok, detail: s2.detail,
      fix: `change WEB_PORT in .env, or  lsof -iTCP:${webPort} -sTCP:LISTEN -Pn` });
  }

  const w = (s: string, n: number) => s + " ".repeat(Math.max(0, n - s.length));
  let bad = 0;
  console.log("Fanwan environment check\n");
  for (const c of checks) {
    const mark = c.ok ? "✓" : "✗";
    if (!c.ok) bad++;
    console.log(`  ${mark} ${w(c.name, 28)} ${c.detail}`);
    if (!c.ok && c.fix) console.log(`        fix: ${c.fix}`);
  }
  console.log();
  if (bad === 0) console.log("All checks passed. Run: bun run scripts/service.ts start");
  else { console.log(`${bad} issue(s) found. Fix them then re-run: bun run scripts/service.ts doctor`); process.exit(1); }
}

const cmd = process.argv[2];
switch (cmd) {
  case "doctor": await cmdDoctor(); break;
  case "install": await cmdInstall(); break;
  case "start": await cmdStart(); break;
  case "stop": await cmdStop(); break;
  case "restart": await cmdStop(); await cmdStart(); break;
  case "status": await cmdStatus(); break;
  case "logs": await cmdLogs(); break;
  default:
    console.log("usage: bun run scripts/service.ts <doctor|install|start|stop|restart|status|logs [api|web]>");
    process.exit(2);
}
