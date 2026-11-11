# chat-share-reader

Export, back up, or archive AI chat conversations to markdown.

Two inputs: public share links, and session files already on your disk. It reads the data endpoints behind each share page instead of reconstructing from rendered DOM, so tables, code fences, inline markup, and per-message timestamps come out intact.

[中文说明](README.zh.md)

```bash
npx skills add mapleleo-hub/chat-share-reader
```

## Requirements

Only **Node.js 22+** is required. The rest is optional and only unlocks more sites.

| Dependency | Without it |
| --- | --- |
| Node 22+ | Nothing runs (uses built-in `WebSocket` and `node:sqlite`) |
| Chrome or Edge | Claude, Perplexity, Grok unavailable |
| Convolvger (Python 3.12+ or uv) | Gemini, DeepSeek, Kimi, Qwen unavailable |

Works with Node alone: ChatGPT and WorkBuddy share links, plus the JSONL session stores (Claude Code, Codex, pi, Oh My Pi).

## Share links: nine sites

| Site | URL shape | Channel |
| --- | --- | --- |
| ChatGPT | `chatgpt.com/share/<uuid>` | HTTP |
| WorkBuddy | `workbuddy.link/p/<id>` | HTTP |
| Gemini | `gemini.google.com/share/<id>` | Convolvger |
| DeepSeek | `chat.deepseek.com/share/<id>` | Convolvger |
| Kimi | `kimi.com/share/<id>` | Convolvger |
| Qwen | `chat.qwen.ai/s/<id>` | Convolvger |
| Claude | `claude.ai/share/<uuid>` | browser |
| Perplexity | `perplexity.ai/search/<uuid>` | browser |
| Grok | `grok.com/share/<id>` | browser |

Two browser backends, picked automatically: [opencli](https://github.com/jackwener/opencli) if installed, otherwise a built-in DevTools Protocol client using Node 22's `WebSocket` with zero npm dependencies.

## Local sessions: 15 sources

```bash
$ node skills/chat-share-reader/scripts/sessions.mjs sources
claude      Claude Code   found     ~/.claude/projects
codex       Codex CLI     found     ~/.codex/sessions
opencode    opencode      usable    ~/.local/share/opencode/opencode.db
cursor      Cursor        usable    %APPDATA%/Cursor/User/globalStorage/state.vscdb
...
```

Verified against real sessions: Claude Code, Codex CLI, pi, Oh My Pi, Cursor, zcode, opencode.

Implemented from upstream formats, not yet verified locally: Gemini CLI, Qwen Code, Cline, Copilot CLI, Command Code, Kimi Code, Antigravity, Hermes.

Per-source paths, record shapes, and known traps: [`references/sessions.md`](skills/chat-share-reader/references/sessions.md).

```bash
node skills/chat-share-reader/scripts/sessions.mjs list --limit 20
node skills/chat-share-reader/scripts/sessions.mjs search "keyword"
node skills/chat-share-reader/scripts/sessions.mjs export <id-prefix> --stdout
```

`export --stdout` pipes straight into another agent, which is the fastest way to carry a previous conversation's context forward.

## Usage

```bash
node skills/chat-share-reader/scripts/read.mjs <url> [more urls...] [--out DIR] [--stdout] [--json]
```

Default output goes to `./chat-shares/<title>.md`. `--stdout` prints, `--json` returns structured results, `--no-vendor` skips Convolvger for debugging.

## Known limits

- Public shares only. Private links are out of reach.
- Cloudflare blocks in time windows, not by cookie state. The same machine may be blocked for an hour and then recover on its own. Waiting works; rotating user agents does not.
- Sites behind an interactive Cloudflare challenge (Perplexity, Grok) need one manual verification in the popup window. The cookie persists in a dedicated Chrome profile afterwards.
- Perplexity caps at 20 turns per fetch.
- Every endpoint here is a private API the site uses for its own frontend. No compatibility promises. They break on redesign.
- Windsurf / Devin sessions are encrypted protobuf. JetBrains AI Assistant hides them in base64 JSON. Neither is supported.

## Prior art

- **Convolvger** (PyPI `convolvger`): 8 providers, local-first, no cookies or API keys. Handles Gemini, DeepSeek, Kimi, Qwen.
- **deja-vu** (`vshulcz/deja-vu`): a format registry covering 43 coding agents. Most local-session parsing here follows its observations.
- **csctf**: Bun + Playwright, 4 providers, DOM reconstruction, requires restarting Chrome for Claude. Not used.

## License

MIT
