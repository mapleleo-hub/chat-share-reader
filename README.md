# chat-share-reader

把 AI 对话的公开分享链接抓成本地 markdown。保留表格、代码块、行内标记和每条消息的时间，输出是接口返回的 markdown 原文，不是从渲染结果里重建的。

支持九个站点，其中五个不需要浏览器。

## 为什么需要它

拿一条 `claude.ai/share/...` 或 `chatgpt.com/share/...` 的链接，直接抓 HTML 会得到三种不同的失败：空壳、Cloudflare 挑战页、iframe 框架。三种都是 HTTP 200，不看内容会以为成功了。

每个站的数据藏在不同地方，这个工具按站分流：

| 站点 | 链接形态 | 通道 |
| --- | --- | --- |
| ChatGPT | `chatgpt.com/share/<uuid>` | HTTP，`backend-api/share` |
| WorkBuddy | `workbuddy.link/p/<id>` | HTTP，页面内嵌 bootstrap 指向的 `conversation-data.json` |
| Gemini | `gemini.google.com/share/<id>`、`share.gemini.google/<token>` | Convolvger（batchexecute RPC） |
| DeepSeek | `chat.deepseek.com/share/<id>` | Convolvger |
| Kimi | `kimi.com/share/<id>` | Convolvger |
| Qwen | `chat.qwen.ai/s/<id>` | Convolvger |
| Claude | `claude.ai/share/<uuid>` | 浏览器，页面内 `fetch(/api/chat_snapshots/...)` |
| Perplexity | `perplexity.ai/search/<uuid>` | 浏览器，页面内 `fetch(/rest/thread/...)` |
| Grok | `grok.com/share/<id>` | 浏览器，渲染后取 DOM |

## 要求

- **Node.js 22 或更高**。用到内置的 `WebSocket`，20 及以下跑不了 CDP 后端。
- **Convolvger（可选，推荐）**。覆盖 Gemini / DeepSeek / Kimi / Qwen 四站。不装这四站不可用。

  ```bash
  uv tool install convolvger     # 需要 Python 3.12+
  # 或者 pip install convolvger
  # 或者完全不预装：装了 uv 的话，脚本会自动用 uvx convolvger
  ```

- **浏览器后端（可选）**。Claude / Perplexity / Grok 三站需要，二选一：
  - **Chrome 或 Edge**：脚本自动拉起，零安装。首次访问有 Cloudflare 挑战的站点时，需要你在弹出的窗口里手动过一次验证，之后 cookie 存在持久 profile 里。
  - **opencli**：如果你已经在用，设 `OPENCLI_BIN` 指过去，脚本优先用它。

## 用法

```bash
node scripts/read.mjs <url> [更多 url...] [--out DIR] [--stdout] [--json] [--no-vendor]
```

```bash
node scripts/read.mjs https://chatgpt.com/share/xxxx
node scripts/read.mjs url1 url2 url3 --out ./exports
node scripts/read.mjs https://claude.ai/share/xxxx --stdout
```

| 参数 | 作用 |
| --- | --- |
| `--out DIR` | 输出目录，默认 `./chat-shares` |
| `--stdout` | 打印到标准输出，不落盘 |
| `--json` | 输出结构化结果，给上层脚本消费 |
| `--no-vendor` | 跳过 Convolvger，强制用自己的实现（调试用） |

文件名取对话标题，重名时自动加 share id 后缀（DeepSeek 所有分享的标题都是 `Shared Conversation`，不处理会互相覆盖）。

## 配置

路径和端口不写死在代码里。可选配置文件 `~/.chat-share-reader/config.json`：

```json
{
  "backend": "auto",
  "convolvgerBin": "/usr/local/bin/convolvger",
  "opencliBin": "~/bin/opencli",
  "chromeBin": "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "profile": "~/.chat-share-reader/chrome-profile",
  "port": 9333
}
```

用 `CSR_CONFIG` 指向别处的配置文件。环境变量优先级更高：

| 变量 | 作用 |
| --- | --- |
| `CSR_BACKEND` | `auto` / `opencli` / `cdp` |
| `CONVOLVGER_BIN` | Convolvger 可执行文件 |
| `OPENCLI_BIN` | opencli 可执行文件 |
| `CHROME_BIN` | Chrome / Edge 路径 |
| `CSR_PROFILE` | CDP 后端的 Chrome profile 目录 |
| `CSR_PORT` | CDP 调试端口，默认 9333 |

## 本地会话

分享链接只覆盖别人发来的对话。你自己机器上的会话记录是另一条路径，用 `sessions.mjs`：

```bash
node scripts/sessions.mjs list                          # 最近的会话
node scripts/sessions.mjs list --source codex --limit 10
node scripts/sessions.mjs search "架构"                  # 全文搜
node scripts/sessions.mjs export 01a1af92 --stdout       # 按 id 前缀导出到标准输出
node scripts/sessions.mjs export 01a1af92 --full         # 带上思考与工具调用
```

| 来源 | 位置 | 形态 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<项目>/<sessionId>.jsonl` | JSONL |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL |
| pi | `~/.pi/agent/sessions/<项目>/*.jsonl` | JSONL |
| Oh My Pi | `~/.omp/agent/sessions/<项目>/*.jsonl` | JSONL |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` | SQLite |
| zcode | `~/.zcode/cli/db/db.sqlite` | SQLite |

`node scripts/sessions.mjs sources` 会列出本机每个源是否可用以及具体路径。

`--stdout` 输出可以直接管道给另一个 agent，用来「把那次对话的上下文带过来」。

各源口径上的坑，代码里已处理：

- **Claude Code**：同一文件里混着 attachment、api-request、cost-state 等运行期事件，只取 `type: user|assistant`。子代理消息带 `isSidechain: true`，默认跳过。
- **Codex**：不要用 `response_item/message`，那里含 `role: developer` 的系统提示和记忆注入。正文在 `event_msg/item_completed` 的 `item.type === UserMessage|AgentMessage`。
- **pi / Oh My Pi**：两者格式同源，对话在 `type: message`，`message.role` 为 system 的要跳过。omp 另有 `type: title` 直接存标题，优先用。
- **Cursor**：存在 SQLite 的 `cursorDiskKV` 表，key 是 `composerData:<uuid>`，正文在 `conversation[].text`，`type` 1 是用户、2 是助手。不需要去 `bubbleId:` 那批行取，实测那些行大多不存在。
- **zcode**：`session` / `message` / `part` 三表，`message.data.role` 区分角色，正文是 `part.data.type === "text"` 的拼接。

SQLite 用 Node 22 内置的 `node:sqlite`，只读打开，不装任何依赖。

## 已知限制

- 只对**公开分享**有效。需要登录态的私有分享拿不到。
- **Cloudflare 是时段性拦截，不是 cookie 问题**。同一台机器可能这一小时全站被拦、下一小时自行恢复。遇到就等一会儿，调 UA 和 headers 没用。
- Grok 的浏览器页面和接口是两套 CF 判定：页面能打开时，无 cookie 请求接口仍然 403，所以它只能走渲染。
- Perplexity 一次最多拿 20 轮，`has_next_page` 为真时说明还有后续。
- 各站的接口都是前端自用的私有接口，不是对外承诺的 API，改版就断。断了看 `references/sites.md` 里的结构说明。

## 加站点

`scripts/sites/` 下一个模块，导出 `name`、`channel`、`match(url)`、`read(url, { session })`，登记进 `scripts/read.mjs` 的 `SITES` 数组。

`read` 返回 `{ title, messages: [{role, time, body}], source, note }`，`body` 必须是 markdown 原文。需要浏览器的模块加 `export const useVendor = true` 表示允许先试 Convolvger。

## 许可

MIT
