---
name: chat-share-reader
description: "Export, back up, or archive AI chat conversations to markdown. Two inputs: public share links (ChatGPT, Claude, Gemini, Grok, Perplexity, DeepSeek, Kimi, Qwen, WorkBuddy) and 15 local agent session stores (Claude Code, Codex, Cursor, opencode, Cline, Gemini CLI, Copilot CLI, Kimi Code, Antigravity, Hermes, pi, Oh My Pi, zcode, Qwen Code, Command Code). Search past sessions by keyword, filter by working directory, batch export, read compressed .jsonl.zst archives, and pipe a previous session's context into the current conversation. 导出、备份、归档 AI 对话为 markdown，支持公开分享链接和 15 种本机 agent 会话记录，可按关键词搜索、按工作目录筛选、批量导出，能读压缩归档。"
license: MIT
metadata:
  openclaw:
    requires:
      bins: ["node"]
    optional:
      bins: ["google-chrome", "convolvger"]
  clawdbot:
    requires:
      bins: ["node"]
    optional:
      bins: ["google-chrome", "convolvger"]
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
- 导出对话
- 备份对话
- 归档聊天记录
- 批量导出会话
- 搜索历史会话
- 对话转 markdown
- 搜索历史会话
- 导出 Claude Code 会话
- 导出 Codex 会话
---

# chat-share-reader

两个入口，解决同一件事的两半：**别人发来的分享链接**，和**你自己机器上的会话记录**。

只需要 Node 22。浏览器和 Python 都是可选的，只有部分站点用得上。

输出语言跟随系统 locale，也可用 `CSR_LANG=en` 或 `CSR_LANG=zh` 强制。终端提示、导出文件的元信息标题、角色名都跟着变。

```bash
CSR_LANG=en node scripts/sessions.mjs list --limit 5
```

```bash
# 分享链接（九个站点）
node scripts/read.mjs <url> [更多 url...] [--out DIR] [--stdout] [--json]

# 本地会话（16 个源）
node scripts/sessions.mjs list [--source claude|codex|workbuddy|all] [--limit 20] [--cwd 子串]
node scripts/sessions.mjs search <关键词> [--limit 20] [--cwd 子串]
node scripts/sessions.mjs export <id 前缀或路径> [--stdout] [--full] [--json]
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

## 登录态批量导出

`read.mjs` 一次只处理一条分享链接，`bulk.mjs` 处理你自己账号下的全部历史。区别在接口：分享走免认证的 `/share/<id>`，批量走登录后才放行的列表与详情接口。

现成站点与通道（2026-11 实测）：

| 站 | 通道 | 鉴权 | 备注 |
| --- | --- | --- | --- |
| DeepSeek | 接口 | localStorage 的 `userToken`（形如 `{"value":"..."}`） | 正文在 `chat_messages[].fragments`，分 REQUEST/SEARCH/THINK/RESPONSE 四类 |
| ChatGPT | 接口 | `/api/auth/session` 的 `accessToken`，走 Bearer | 只带 cookie 会返回 `total:0` 而不报错；tpp 空间与普通空间是两套列表 |
| Grok | 接口 | cookie，但必须顶层 XHR | 同源 iframe 的 fetch 被 CF 拦成挑战页 |
| Perplexity | 接口 | cookie | 无列表接口，从侧边栏 `/session/` 链接收；正文在 `entry.text` 的 FINAL 步骤，`content.answer` 还是层 JSON |
| Gemini | DOM | cookie | batchexecute RPC 逆向成本高；必须前台窗口 + 等十几秒渲染；虚拟滚动要往上滚才能载全 |
| Qwen | 接口 | — | 阿里 WAF 把接口拦成挑战 HTML，未打通 |
| Kimi | 接口 | — | 未实测 |

三条硬约束，改之前先看：

1. **页面里的 `fetch` 和 `XHR` 都可能被站点自己改写**。Qwen 的阿里埋点包了 `window.fetch`，请求会直接挂起；WAF 又会挂掉 XHR。所以 `__req` 优先用同源空白 iframe 的 `contentWindow.fetch`（没被碰过的原生实现），再退 XHR，最后才用被改写过的 fetch。
2. **接口路径不要猜**，跑 `probe`：读 `performance.getEntriesByType("resource")` 拿页面自己发过的接口，逐个打一次打状态和响应开头。字段名也从这里读。
3. **WAF 是单独的墙**。Qwen、豆包的接口对脚本请求会返回阿里云 WAF 的挑战 HTML（`aliyun_waf_aa`），200 状态但内容不是 JSON。这类站点要么靠真实 UI 交互加载，要么放弃接口路径。

登录检测：`openSite` 之后看 URL 是否落回 `sign_in|login`，落回去直接报错让人先登录。不要试图替用户登录，也不要读 cookie 库（Chrome 对 `Cookies` 文件独占锁，`mode=ro` 也打不开）。

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

先跑 `node scripts/sessions.mjs sources` 看本机哪些源可用。

实测通过：Claude Code、Codex CLI、WorkBuddy、pi、Oh My Pi、Cursor、zcode、opencode。
按上游格式实现但本机未实测：Gemini CLI、Qwen Code、Cline、Copilot CLI、Command Code、Kimi Code、Antigravity、Hermes。

各源路径、格式、字段映射见 `references/sessions.md`。

```bash
node scripts/sessions.mjs list --limit 20             # 按修改时间倒序
node scripts/sessions.mjs search "关键词"              # 只搜对话正文，不搜文件原文
node scripts/sessions.mjs search "关键词" --cwd 项目名  # 先按工作目录筛，快很多
node scripts/sessions.mjs export 01a1af92 --stdout    # id 前缀匹配，同线程分片自动合并
node scripts/sessions.mjs export 01a1af92 --json      # 结构化，含 segments 与每条消息
node scripts/sessions.mjs export <路径> --full         # 带上思考与工具调用
```

口径坑，代码里已处理，改解析器前先看：

1. **Claude Code**：一个文件混着 attachment、api-request、cost-state 等运行期事件，只取 `type: user|assistant`。子代理消息带 `isSidechain: true`，默认跳过。
2. **Codex**：不要用 `response_item/message`，那里混着 `role: developer` 的系统提示和记忆注入。正文在 `event_msg/item_completed` 的 `item.type === UserMessage|AgentMessage`。Codex 还会把内部上下文和浏览器审批 JSON 塞进同两个通道，`isInternal` 会滤掉。
3. **pi / Oh My Pi**：格式同源，`type: message` 里 `message.role` 为 system 的要跳过，omp 的 `type: title` 直接就是标题。
4. **Cursor**：SQLite 的 `cursorDiskKV` 表，key 为 `composerData:<uuid>`，正文在 `conversation[].text`（1=用户，2=助手）。
5. **zcode**：`session` / `message` / `part` 三表，正文取 `part.data.type === "text"`。
6. **压缩 rollout**：Codex 归档会话是 `archived_sessions/*.jsonl.zst`，且读过之后会被解压搬回 `sessions/`。`lib/local/zst.mjs` 透明解压（Node 22 的 zlib zstd，缺了回退系统 `zstd` 命令），两个目录都扫。直接 grep `.zst` 永远搜不到，别据此判断会话不存在。
7. **fork 分片**：同一会话可能有十几个 `rollout-<时间>-<线程>_<分支>.jsonl`，分片名会用新 id，但 `session_meta.session_id` 仍是父线程的。`export` 按它归组、按消息时间排序、按角色加正文前缀去重。
8. **WorkBuddy**：`~/.workbuddy/projects/<工作区 slug>/<sessionId>.jsonl`，同级 `<sessionId>/tool-results/` 要排除。每条用户消息前挂 `<system-reminder>` 包住的 user_info、identity 文件和自定义指令，必须整块剥掉，否则标题会变成 `<system-reminder`。
9. **search 只匹配正文**：原文里一条记忆注入带过项目路径，就能让几十个无关会话命中。所以 search 要先 parse 成 messages 再匹配，不能对文件原文 `indexOf`。

SQLite 走 Node 22 内置 `node:sqlite`，只读，无依赖。

## 已知边界

- 只对公开分享有效，私有分享拿不到。
- Perplexity 一次最多 20 轮，`has_next_page` 为真说明还有后续页。
- 各站接口都是前端自用的私有接口，改版就断。
- Codex 会自己收拾归档目录，压缩分片可能被合并或删掉。真要长期留档，先用 `export` 存成 markdown，别指望原始 rollout 一直在。
- `search` 不带 `--cwd` 时要解析全部会话，本机约四千个文件十几秒。日常找项目相关的对话先加 `--cwd 项目名`。

## 调研过，别重复找

- **Convolvger**（PyPI `convolvger`）：8 provider，本地优先，无 cookie 无 API key。**已作为主通道**。
- **csctf**（`Dicklesworthstone/chat_shared_conversation_to_file`）：Bun + Playwright，4 provider，走 DOM 重建，Claude 那条要重启 Chrome。**未采用**，覆盖更少且保真度更低。

其余命中都是浏览器扩展（导出自己账号历史）或本地会话导出工具，不解决「给一条链接」这个输入。
