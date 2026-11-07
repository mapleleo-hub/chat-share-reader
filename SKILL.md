---
name: chat-share-reader
description: 把 AI 对话的公开分享链接抓成本地 markdown，保留表格、代码块、行内标记与每条消息的时间。覆盖 ChatGPT、Claude、Gemini、Grok、Perplexity、DeepSeek、Kimi、Qwen、WorkBuddy 九站。需要把别人发来的对话链接、或自己分享出去的对话存档时使用。
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

把分享链接变成可读的 markdown。多数 agent 拿到这类链接只会抓 HTML，结果是空壳、Cloudflare 挑战页或 iframe 框架，三种都是 HTTP 200，不看内容会以为成功了。

## 用法

```bash
node scripts/read.mjs <url> [更多 url...] [--out DIR] [--stdout] [--json] [--no-vendor]
```

```bash
node scripts/read.mjs https://chatgpt.com/share/xxxx
node scripts/read.mjs url1 url2 --out ./exports
node scripts/read.mjs https://claude.ai/share/xxxx --stdout
```

默认写到 `./chat-shares/<标题>.md`。`--stdout` 直接打印，`--json` 给结构化结果，`--no-vendor` 强制跳过 Convolvger（调试用）。多个链接一次跑完，单条失败不影响其他条。

## 三个通道，按站点分流

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

## 已知边界

- 只对公开分享有效，私有分享拿不到。
- Perplexity 一次最多 20 轮，`has_next_page` 为真说明还有后续页。
- 本地会话文件（Claude Code 的 `~/.claude/projects/*.jsonl`、Codex 的 `~/.codex/sessions/`）不在本 skill 范围内，那是另一条路径。
- 各站接口都是前端自用的私有接口，改版就断。

## 调研过，别重复找

- **Convolvger**（PyPI `convolvger`）：8 provider，本地优先，无 cookie 无 API key。**已作为主通道**。
- **csctf**（`Dicklesworthstone/chat_shared_conversation_to_file`）：Bun + Playwright，4 provider，走 DOM 重建，Claude 那条要重启 Chrome。**未采用**，覆盖更少且保真度更低。

其余命中都是浏览器扩展（导出自己账号历史）或本地会话导出工具，不解决「给一条链接」这个输入。
