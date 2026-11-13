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

Works with Node alone: ChatGPT, WorkBuddy and Biji (得到大脑) share links, plus the JSONL session stores (Claude Code, Codex, pi, Oh My Pi).

## Share links: ten sites

| Site | URL shape | Channel |
| --- | --- | --- |
| ChatGPT | `chatgpt.com/share/<uuid>` | HTTP |
| WorkBuddy | `workbuddy.link/p/<id>` | HTTP |
| Biji (得到大脑) | `biji.com/note/share_note/<id>` | HTTP |
| Gemini | `gemini.google.com/share/<id>` | Convolvger |
| DeepSeek | `chat.deepseek.com/share/<id>` | Convolvger |
| Kimi | `kimi.com/share/<id>` | Convolvger |
| Qwen | `chat.qwen.ai/s/<id>` | Convolvger |
| Claude | `claude.ai/share/<uuid>` | browser |
| Perplexity | `perplexity.ai/search/<uuid>` | browser |
| Grok | `grok.com/share/<id>` | browser |

Biji is a voice-note site rather than a chat site. An export carries two parts: the organized note and a timestamped transcript. Only the public share API works. Rendering the page gives less, because the desktop viewport is blank and the body lazy-loads.

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
node skills/chat-share-reader/scripts/sessions.mjs export              # the session you are in right now
node skills/chat-share-reader/scripts/sessions.mjs export <id-prefix> --stdout
```

`export` with no argument exports the session you are currently in. It reads the host agent's session id from the environment (`CODEBUDDY_SESSION_ID`, `CLAUDE_SESSION_ID`, `CODEX_THREAD_ID`, ...), and falls back to "newest session in this working directory within the last hour". The fallback is a heuristic, so it prints which session it picked. Only the WorkBuddy variable is verified on a real machine; the rest are written from community implementations.

`export --stdout` pipes straight into another agent, which is the fastest way to carry a previous conversation's context forward.

## Redaction

Exports are redacted by default. Home directories become `~`, other users' on the same machine become `~user`; the directory structure stays readable. The header records the level and how many spots were replaced.

```bash
--redact off      # raw text
--redact home     # default
--redact strict   # also masks emails, tokens (sk-, ghp_, JWT, Bearer), private IPs
```

Public IPs and commit hashes are left alone: those usually carry meaning. Redaction lives in `lib/redact.mjs` and applies to every export path, including the third-party Convolvger channel. It is idempotent, so re-running on an already redacted file changes nothing.

## Usage

```bash
node skills/chat-share-reader/scripts/read.mjs <url> [more urls...] [--out DIR] [--stdout] [--json] [--redact off|home|strict]
```

Default output goes to `./chat-shares/<title>.md`. `--stdout` prints, `--json` returns structured results, `--no-vendor` skips Convolvger for debugging.

## Bulk export (your own account)

Share links cover conversations someone sent you. Two scripts cover your own history.

```bash
# Every conversation on a site you are signed in to (needs opencli)
node skills/chat-share-reader/scripts/bulk.mjs sites
node skills/chat-share-reader/scripts/bulk.mjs list   --site deepseek --limit 20
node skills/chat-share-reader/scripts/bulk.mjs export --site deepseek --out DIR --since 2026-09-01

# Biji voice notes (class and meeting recordings), transcripts optional
node skills/chat-share-reader/scripts/biji-notes.mjs list   --since 2026-11-01 --type class_audio
node skills/chat-share-reader/scripts/biji-notes.mjs export --since 2026-11-11 --until 2026-11-12 --out DIR --transcript
```

`bulk.mjs` reuses the signed-in browser session through opencli, so there is no token juggling. `probe` re-calibrates a site's endpoints when the site changes.

`biji-notes.mjs` needs `BIJI_TOKEN` or a signed-in opencli session. It pages through the account list and can attach the per-note transcript.

## Known limits

- Public shares only. Private links are out of reach.
- Cloudflare blocks in time windows, not by cookie state. The same machine may be blocked for an hour and then recover on its own. Waiting works; rotating user agents does not.
- Sites behind an interactive Cloudflare challenge (Perplexity, Grok) need one manual verification in the popup window. The cookie persists in a dedicated Chrome profile afterwards.
- Perplexity caps at 20 turns per fetch.
- Every endpoint here is a private API the site uses for its own frontend. No compatibility promises. They break on redesign.
- Windsurf / Devin sessions are encrypted protobuf. JetBrains AI Assistant hides them in base64 JSON. Neither is supported.

## Development

No dependencies, no install step. Tests use the Node built-in runner:

```bash
cd skills/chat-share-reader
npm test                 # default output language
CSR_LANG=zh npm test     # the output language is a runtime switch; test both
```

CI runs the same suite on Ubuntu and Windows with Node 22, in both languages.

Covered: redaction levels and idempotence, the untrusted-content fence and heading demotion, shard merging (dedupe, reordering, tool messages without timestamps), and that both CLIs start with the right exit codes.

Not covered: the per-site adapters in `scripts/sites/`. They talk to private endpoints and need a signed-in browser profile, so a failure there is indistinguishable from a real regression in a unit test. Check them by hand with `node scripts/read.mjs <url> --stdout`.

## Prior art

- **Convolvger** (PyPI `convolvger`): 8 providers, local-first, no cookies or API keys. Handles Gemini, DeepSeek, Kimi, Qwen.
- **deja-vu** (`vshulcz/deja-vu`): a format registry covering 43 coding agents. Most local-session parsing here follows its observations.
- **csctf**: Bun + Playwright, 4 providers, DOM reconstruction, requires restarting Chrome for Claude. Not used.

## License

MIT
