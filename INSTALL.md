# Fanwan — 一次性安装指南

> 这份文档只在**第一次**部署，或 `SKILL.md` 里的健康检查报错时读一遍。
> 安装完成后，所有日常操作只看 `SKILL.md` 即可。
>
> Agent 读这份文档时，请按章节顺序执行，每一步都先跑命令再判断输出。
> 用户的电脑可能什么都没装；不要假设任何工具默认存在。

---

## 0. 拿到仓库（最容易被跳过的一步）

如果 agent 是从外部（URL / skill 描述）读到这份文档，本地大概率**没有** `fanwan/`
目录。任何后续步骤都依赖整个仓库 + 完整 `node_modules` + `web/.next` 构建，
**绝对不要**逐个文件地用 HTTP 拉取源码。

先确认 `git` 可用：

```bash
git --version
# 期望：git version 2.x
```

如缺：

- macOS：`xcode-select --install`（或 `brew install git`）
- Debian/Ubuntu：`sudo apt install -y git`
- Fedora：`sudo dnf install -y git`

然后 clone（位置随意，主目录最省心）：

```bash
cd ~
git clone https://github.com/Yuandiaodiaodiao/fanwan.git
cd fanwan
```

确认你在正确位置：

```bash
ls SKILL.md INSTALL.md package.json scripts/fa.ts
# 这四个文件都必须出现，没有就 cd 错了
```

后续所有命令的工作目录都是这里（`<repo-root>`）。

---

## 1. 操作系统判断

支持 macOS 与 Linux。先确认：

```bash
uname -s
# 期望：Darwin (macOS)  或  Linux
```

- 如果是 **Darwin** → 走 macOS 路线（用 Homebrew 装依赖）。
- 如果是 **Linux** → 用 apt / dnf / pacman。
- Windows：本系统不直接支持，请用 WSL2 后按 Linux 流程走。

---

## 2. 环境依赖清单

| 工具 | 必需？ | 用途 |
|---|---|---|
| `git` | **必需** | §0 已用过，clone 仓库 |
| `bun` ≥ 1.1 | **必需** | 运行 TypeScript 源码、管理依赖、启动 server / Next.js |
| `tmux` | 强烈推荐 | 后台托管 server + web 两个进程；无则降级为 `nohup` |
| `lsof` | 必需 | 端口占用检查 |
| `curl` | 必需 | 验证 API 健康 |

---

## 3. 安装 bun

先看是否已装：

```bash
bun --version
# 期望：1.x.x
```

如果 `command not found`：

### macOS / Linux 通用安装

```bash
curl -fsSL https://bun.sh/install | bash
```

然后**重启终端**或：

```bash
export PATH="$HOME/.bun/bin:$PATH"
echo 'export PATH="$HOME/.bun/bin:$PATH"' >> ~/.zshrc    # 或 ~/.bashrc
```

再次验证：`bun --version` 必须返回版本号。

> ⚠️ 如果 `curl` 也没装，先到第 4 节装 `curl`，再回来装 bun。

---

## 4. 安装 tmux（推荐）

```bash
tmux -V
# 期望：tmux 3.x 之类
```

如果没有：

- **macOS**：先装 Homebrew（如果没有）
  ```bash
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  brew install tmux
  ```
- **Debian / Ubuntu**：`sudo apt update && sudo apt install -y tmux`
- **Fedora / RHEL**：`sudo dnf install -y tmux`
- **Arch**：`sudo pacman -S tmux`

没有 tmux 也能跑（自动降级为 `nohup`），但是日志查看和重启会麻烦一些。

---

## 5. 安装 lsof / curl（一般都已有）

```bash
lsof -v 2>&1 | head -1     # 期望有版本输出（lsof 即使 -v 失败也算装好）
curl --version | head -1   # 期望 curl 7.x / 8.x
```

如缺：

- **macOS**：系统自带，应当都有；若没有就 `brew install lsof curl`
- **Debian / Ubuntu**：`sudo apt install -y lsof curl`

---

## 6. 一次性环境体检（doctor）

把仓库克隆/复制到你想要的位置后，进入仓库：

```bash
cd <repo-root>
bun run scripts/service.ts doctor
```

它会逐项检查：bun / tmux / lsof / curl / `.env` / 依赖目录 / 端口占用。
**所有项必须 ✓** 才进入下一步。任何 ✗ 都会给出 `fix:` 指引，照做即可。

> 如果 doctor 自身跑不起来（`bun: command not found`），回到第 2 步装 bun。

---

## 7. 执行安装

```bash
bun run scripts/service.ts install
```

这条命令会按顺序：

1. `cp .env.example .env`（如果 `.env` 不存在）
2. `mkdir -p data logs`
3. `bun install`（根目录依赖）
4. `cd web && bun install`（Next.js 16 + React 19 依赖）
5. `cd web && bun run build`（生成 `web/.next/` 生产构建）

整个过程大约需要 **30–90 秒**，取决于网速。

完成的标志：终端打印 `[service] install complete.` 且 `web/.next/` 目录存在。

### 如果第 3 步失败（`bun install`）

- 检查是不是网络问题：`curl -I https://registry.npmjs.org`
- 国内网络可设置镜像：
  ```bash
  bun config set registry https://registry.npmmirror.com
  ```
  然后重试 `bun run scripts/service.ts install`。

### 如果第 5 步失败（`next build`）

- 看错误是否提到 TypeScript 版本不兼容；通常 `bun install` 已固定好。
- 删掉 `web/node_modules` 和 `web/.next` 再重装：
  ```bash
  rm -rf web/node_modules web/.next
  bun run scripts/service.ts install
  ```

---

## 8. 配置 `.env`

`install` 已经从模板生成了 `.env`，但你需要**确认/修改两个端口**：

```env
SERVER_PORT=51737          # API 端口，本机内部使用，一般不需要改
WEB_PORT=51738             # 浏览器访问看板的端口
API_BASE_URL=http://localhost:51737   # 必须和 SERVER_PORT 一致
DB_PATH=./data/fanwan.db
API_TOKEN=                 # 可选；只有需要远程访问时才设
SCHEDULER_INTERVAL_MS=15000
```

**Agent 必须主动询问用户希望 `WEB_PORT` 设成多少**（避免与用户已有的开发服务冲突）。
如果用户没特殊要求，默认 `51738` 即可。

> ⚠️ 改了 `SERVER_PORT` 一定要同步改 `API_BASE_URL`，不然 Next.js 的代理会指错。

改完再跑一次 doctor 确认端口不冲突：

```bash
bun run scripts/service.ts doctor
```

---

## 9. 启动服务

```bash
bun run scripts/service.ts start
```

正常输出：

```
[service] started in tmux session 'fanwan'.
  api: http://localhost:51737    log: .../logs/api.log
  web: http://localhost:51738    log: .../logs/web.log
  attach: tmux attach -t fanwan
```

> 如果脚本提示 `node_modules missing` 或 `.next missing` — 回到第 6 步重跑 `install`。
> 如果提示 `port already in use` — 回到第 7 步换端口。

---

## 10. 三个验证步骤（缺一不可）

### 10.1 进程状态

```bash
bun run scripts/service.ts status
```

期望：

```json
{
  "tmux_session": true,
  "server": { "port": 51737, "listening": true },
  "web":    { "port": 51738, "listening": true },
  "env_file": true
}
```

`tmux_session` / `server.listening` / `web.listening` 三项必须都 `true`。

### 10.2 API 健康

```bash
bun run fa health
# 或： curl -s http://localhost:51737/health
```

期望：`{ "ok": true, "service": "fanwan", "time": "…" }`

### 10.3 浏览器看板

打开 `http://localhost:51738/`，应该看到中文版 "Fanwan 告警看板" 界面。

如果浏览器报 `ERR_CONNECTION_REFUSED`：

```bash
bun run scripts/service.ts logs web
```

查看 web 日志的具体报错。常见原因：`next: command not found`
（说明 `web/node_modules` 没装好 → 回到第 6 步）。

---

## 11. 加第一个电话告警渠道

```bash
bun run fa channel add phone default https://fwalert.com/<your-webhook-uuid>
bun run fa call "fanwan install 完成测试"
```

电话应在几秒内响起。如果返回 `HARD_MOBILE_RATE_THROTTLE`，说明 60 秒内已经拨过，
等一分钟再试。

---

## 12. 常用维护命令

```bash
bun run scripts/service.ts status        # 看是否在跑
bun run scripts/service.ts stop          # 停服务
bun run scripts/service.ts restart       # 重启
bun run scripts/service.ts logs api      # tail -f API 日志
bun run scripts/service.ts logs web      # tail -f web 日志
tmux attach -t fanwan                    # 直接附着到 tmux（Ctrl-B D 脱离）
```

---

## 13. 开机自启（可选）

### macOS launchd

`~/Library/LaunchAgents/com.fanwan.plist`：

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.fanwan</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/<YOU>/.bun/bin/bun</string>
    <string>run</string>
    <string>scripts/service.ts</string>
    <string>start</string>
  </array>
  <key>WorkingDirectory</key><string>/path/to/fanwan</string>
  <key>RunAtLoad</key><true/>
  <key>StandardOutPath</key><string>/path/to/fanwan/logs/launchd.log</string>
  <key>StandardErrorPath</key><string>/path/to/fanwan/logs/launchd.err</string>
</dict>
</plist>
```

加载：`launchctl load ~/Library/LaunchAgents/com.fanwan.plist`

### Linux systemd 用户单元

`~/.config/systemd/user/fanwan.service`：

```ini
[Unit]
Description=Fanwan alert & memo platform
After=network.target

[Service]
Type=forking
WorkingDirectory=/path/to/fanwan
ExecStart=/usr/bin/env bun run scripts/service.ts start
ExecStop=/usr/bin/env bun run scripts/service.ts stop
Restart=on-failure

[Install]
WantedBy=default.target
```

启用：`systemctl --user daemon-reload && systemctl --user enable --now fanwan`

---

## 14. 装完之后

一切验证通过后，**不要再回来读这份文档**。日常调用看 `SKILL.md`。

如果某次状态检查失败，先跑 `bun run scripts/service.ts doctor`，
按 `fix:` 提示修复；只有它指出"重装"时才需要重新跑第 7 步。
