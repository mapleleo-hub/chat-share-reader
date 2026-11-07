---
name: chat-share-reader
description: 把 AI 对话抓成本地 markdown，两个入口：公开分享链接（ChatGPT、Claude、Gemini、Grok、Perplexity、DeepSeek、Kimi、Qwen、WorkBuddy 九站），和本机会话文件（Claude Code、Codex CLI、pi、Oh My Pi、Cursor、zcode）。保留表格、代码块与消息时间。需要存档别人发来的对话、搜索自己的历史会话、或把上一轮对话的上下文喂给当前 agent 时使用。
triggers:
- 抓 AI 聊天记录
- 保存分享链接
- 下载对话记录
- 分享链接转 markdown
- claude.ai/share
- chatgpt.com/share
- gemini 分享
- grok 分享
- perplexity 分享
- kimi 分享
- qwen 分享
- deepseek 分享
- workbuddy.link
- 读聊天记录
---

# chat-share-reader

两个入口，解决同一件事的两半：**别人发来的分享链接**，和**你自己机器上的会话记录**。

```bash
# 分享链接（九个站点）
node scripts/read.mjs <url> [更多 url...] [--out DIR] [--stdout] [--json]

# 本地会话（Claude Code / Codex / pi / omp / Cursor / zcode）
node scripts/sessions.mjs list [--source claude|codex|all] [--limit 20]
node scripts/sessions.mjs search <关键词>
node scripts/sessions.mjs export <id 前缀或路径> [--stdout] [--full]
```

典型用法：`sessions.mjs export <id> --stdout` 接管道，把上一轮会话的上下文喂给当前的 agent。

## 分享链接

默认写到 `./chat-shares/<标题>.md`。`--stdout` 直接打印，`--json` 给结构化结果，`--no-vendor` 强制跳过 Convolvger（调试用）。多个链接一次跑完，单条失败不影响其他条。

### 三个通道，按站点分流

| 通道 | 站点 | 依赖 |
| --- | --- | --- |
| HTTP（直连接口） | ChatGPT、WorkBuddy | 只要 Node 22+ |
| Convolvger（第三方 CLI） | Gemini、DeepSeek、Kimi、Qwen | Python 3.12+ 或 uv，`uv tool install convolvger` |
| 浏览器 | Claude、Perplexity、Grok | Chrome/Edge，或 opencli |

`scripts/lib/backend/` 下有两个浏览器实现，自动选：

- **opencli**：本机装了就用（`OPENCLI_BIN` 或 `~/bin/opencli`），复用已有登录态。
- **cdp**：没有 opencli 时，用 Node 22 内置 WebSocket 直连 Chrome/Edge 的 DevTools 协议，零 npm 依赖，跨平台。

cdp 后端首次访问有 Cloudflare 挑战的站点时会打印提示，等你在弹出的窗口里手动过一次验证，之后 cookie 存在持久 profile 里。

## 不要再造轮子

- **Convolvger 已覆盖四个站**，不要自己写 Gemini/DeepSeek/Kimi/Qwen 的解析。它带快照时间、conversation id、每条消息原始时间戳。
- **不要用 `opencli browser extract`**，它把 table 拍平成逐单元格段落。
- **优先取接口的 markdown 原文**，DOM 重建只作兜底。

## 改代码前必须知道

1. **Convolvger 退出码不可信**。有 warning 时返回非零，但内容已完整产出。判成败看 stdout 有没有 `Provider:` 行、输出文件存不存在。
2. **Cloudflare 是时段性拦截**，不是 cookie 缺失也不是代码问题。实测同一台机器上 `grok.com` 全站拦了约一小时后自行恢复。遇到就等，不要调 UA。
3. **Perplexity 的参数不能精简**。27 个 `supported_block_use_cases` 少一个，接口照样 200 但不下发回答正文。
4. **Grok 的就绪判定不能用正文长度**。导航栏本身有 400 多字，要用消息容器出现作为信号。
5. **opencli eval 的三条限制**（改 `backend/opencli.mjs` 时相关）：吃单引号、单次表达式约 5k 字符上限、含 `{}` 直接挂。页面脚本一律 base64 分片注入。

各站接口细节、数据结构、失败形态见 `references/sites.md`。加站点的方法见 `README.md`。

## 本地会话

分享链接只覆盖别人发来的对话。自己机器上的记录走 `sessions.mjs`，不依赖网络，不需要任何后端。

| 来源 | 位置 | 形态 |
| --- | --- | --- |
| Claude Code | `~/.claude/projects/<项目>/<sessionId>.jsonl` | JSONL |
| Codex CLI | `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` | JSONL |
| pi | `~/.pi/agent/sessions/<项目>/*.jsonl` | JSONL |
| Oh My Pi | `~/.omp/agent/sessions/<项目>/*.jsonl` | JSONL |
| Cursor | `%APPDATA%/Cursor/User/globalStorage/state.vscdb` | SQLite |
| zcode | `~/.zcode/cli/db/db.sqlite` | SQLite |

先跑 `node scripts/sessions.mjs sources` 看本机哪些源可用。

```bash
node scripts/sessions.mjs list --limit 20            # 按修改时间倒序
node scripts/sessions.mjs search "关键词"             # 全文搜，给上下文片段
node scripts/sessions.mjs export 01a1af92 --stdout   # id 前缀匹配
node scripts/sessions.mjs export <路径> --full        # 带上思考与工具调用
```

口径坑，代码里已处理，改解析器前先看：

1. **Claude Code**：一个文件混着 attachment、api-request、cost-state 等运行期事件，只取 `type: user|assistant`。子代理消息带 `isSidechain: true`，默认跳过。
2. **Codex**：不要用 `response_item/message`，那里混着 `role: developer` 的系统提示和记忆注入。正文在 `event_msg/item_completed` 的 `item.type === UserMessage|AgentMessage`。
3. **pi / Oh My Pi**：格式同源，`type: message` 里 `message.role` 为 system 的要跳过，omp 的 `type: title` 直接就是标题。
4. **Cursor**：SQLite 的 `cursorDiskKV` 表，key 为 `composerData:<uuid>`，正文在 `conversation[].text`（1=用户，2=助手）。
5. **zcode**：`session` / `message` / `part` 三表，正文取 `part.data.type === "text"`。

SQLite 走 Node 22 内置 `node:sqlite`，只读，无依赖。

## 已知边界

- 只对公开分享有效，私有分享拿不到。
- Perplexity 一次最多 20 轮，`has_next_page` 为真说明还有后续页。
- 各站接口都是前端自用的私有接口，改版就断。

## 调研过，别重复找

- **Convolvger**（PyPI `convolvger`）：8 provider，本地优先，无 cookie 无 API key。**已作为主通道**。
- **csctf**（`Dicklesworthstone/chat_shared_conversation_to_file`）：Bun + Playwright，4 provider，走 DOM 重建，Claude 那条要重启 Chrome。**未采用**，覆盖更少且保真度更低。

其余命中都是浏览器扩展（导出自己账号历史）或本地会话导出工具，不解决「给一条链接」这个输入。
