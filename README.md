# chat-share-reader

把 AI 对话抓成本地 markdown。两种输入：别人发来的公开分享链接，和你自己机器上的会话文件。

抓的是各站分享页背后那套数据接口，不是从渲染结果里重建。表格、代码块、行内标记、每条消息的时间都保留原样。

[![skills.sh](https://img.shields.io/badge/skills.sh-listed-000)](https://www.skills.sh/mapleleo-hub/chat-share-reader)

```bash
npx skills add mapleleo-hub/chat-share-reader
```

装完会自动链接到 Claude Code、Codex、Cursor、Gemini CLI、Cline、opencode、Copilot、Kimi Code、Antigravity、Hermes 等 19 个 agent。

## 解决什么

拿一条 `claude.ai/share/...` 或 `chatgpt.com/share/...` 的链接，直接抓 HTML 会得到三种不同的失败：空壳、Cloudflare 挑战页、iframe 框架。三种都是 HTTP 200，不看内容会以为成功了。

每个站的数据藏在不同地方，这个工具按站分流。另外一半需求是反过来的：你想把上一轮某个会话的上下文带进当前对话，那部分数据就在你自己磁盘上。

## 两个入口

```bash
# 分享链接
node skills/chat-share-reader/scripts/read.mjs <url> [更多 url...] [--out DIR] [--stdout] [--json]

# 本地会话
node skills/chat-share-reader/scripts/sessions.mjs sources
node skills/chat-share-reader/scripts/sessions.mjs list --limit 20
node skills/chat-share-reader/scripts/sessions.mjs search "关键词"
node skills/chat-share-reader/scripts/sessions.mjs export <id> --stdout
```

最后一个配管道最有用：把某次会话导出来，直接喂给当前的 agent。

## 依赖

只需要 **Node.js 22+**。其余都是可选的，缺了只是少几个站点。

| 依赖 | 缺了会怎样 |
| --- | --- |
| Node 22+ | 跑不了（用到内置 `WebSocket` 和 `node:sqlite`） |
| Chrome 或 Edge | Claude、Perplexity、Grok 三站不可用 |
| Convolvger（Python 3.12+ 或 uv） | Gemini、DeepSeek、Kimi、Qwen 四站不可用 |

零依赖就能用的部分：ChatGPT、WorkBuddy 两个分享站，加上 15 个本地会话源里的 JSONL 类（Claude Code、Codex、pi、Oh My Pi）。

## 分享链接：九个站点

| 站点 | 链接形态 | 通道 |
| --- | --- | --- |
| ChatGPT | `chatgpt.com/share/<uuid>` | HTTP |
| WorkBuddy | `workbuddy.link/p/<id>` | HTTP |
| Gemini | `gemini.google.com/share/<id>` | Convolvger |
| DeepSeek | `chat.deepseek.com/share/<id>` | Convolvger |
| Kimi | `kimi.com/share/<id>` | Convolvger |
| Qwen | `chat.qwen.ai/s/<id>` | Convolvger |
| Claude | `claude.ai/share/<uuid>` | 浏览器 |
| Perplexity | `perplexity.ai/search/<uuid>` | 浏览器 |
| Grok | `grok.com/share/<id>` | 浏览器 |

浏览器通道有两个实现，自动选：本机有 opencli 就用它，没有就用 Node 22 内置的 WebSocket 直连 Chrome 的 DevTools 协议，不装任何 npm 包。

## 本地会话：15 个源

```bash
$ node skills/chat-share-reader/scripts/sessions.mjs sources
claude      Claude Code  有目录    ~/.claude/projects
codex       Codex CLI    有目录    ~/.codex/sessions
opencode    opencode     可用      ~/.local/share/opencode/opencode.db
cursor      Cursor       可用      %APPDATA%/Cursor/User/globalStorage/state.vscdb
...
```

实测通过（本机有真实会话）：Claude Code、Codex CLI、pi、Oh My Pi、Cursor、zcode、opencode。

按上游格式实现（本机没跑过对话，未实测）：Gemini CLI、Qwen Code、Cline、Copilot CLI、Command Code、Kimi Code、Antigravity、Hermes。

每个源的路径、格式、字段映射与已知坑见 [`skills/chat-share-reader/references/sessions.md`](skills/chat-share-reader/references/sessions.md)。

## 输出示例

```markdown
# 询问是否安装 grill me

- 来源：~/.local/share/opencode/opencode.db#ses_fd7dc2983ffe
- 抓取通道：local/opencode
- 消息条数：14
- 字符数：2798

## 用户 · 14:23

你安装了 grill me 吗

## opencode · 14:29

没有。要装的话我可以帮你跑安装命令……
```

正文里的标题会自动降两级，保证「角色」这一层的层级不被淹没。

## 已知限制

- 只对公开分享有效，私有分享拿不到。
- Cloudflare 是时段性拦截，不是 cookie 问题。同一台机器可能这一小时全站被拦、下一小时自行恢复。遇到就等一会儿，调 UA 没用。
- 首次访问有 Cloudflare 挑战的站点（Perplexity、Grok）需要在弹出的浏览器窗口里手动过一次验证，之后 cookie 存在持久 profile 里。
- Perplexity 一次最多 20 轮。
- 各站接口都是前端自用的私有接口，不是对外承诺的 API，改版就断。
- Windsurf / Devin Desktop 的会话是加密 protobuf，JetBrains AI Assistant 藏在 base64 JSON 里，这两类不支持。

## 加站点

`skills/chat-share-reader/scripts/sites/` 下一个模块，导出 `name`、`channel`、`match(url)`、`read(url, { session })`，登记进 `read.mjs` 的 `SITES` 数组。本地会话源放在 `scripts/lib/local/`，登记进 `sessions.mjs` 的 `SOURCES`。

## 调研过，别重复找

- **Convolvger**（PyPI `convolvger`）：8 个 provider，本地优先，无 cookie 无 API key。Gemini、DeepSeek、Kimi、Qwen 四站直接交给它。
- **csctf**（`Dicklesworthstone/chat_shared_conversation_to_file`）：Bun + Playwright，4 个 provider，走 DOM 重建，Claude 那条要重启 Chrome。未采用。
- **deja-vu**（`vshulcz/deja-vu`）：43 个 agent 的会话格式登记表，本地会话源的路径与格式大量参考了它。

## 许可

MIT
