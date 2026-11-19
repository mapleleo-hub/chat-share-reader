#!/usr/bin/env node
// 本地会话入口：列出、搜索、导出本机各 AI 编码 agent 的会话记录。
//
// 用法：
//   node sessions.mjs sources
//   node sessions.mjs list [--source <名字>|all] [--limit 20] [--cwd <子串>] [--json]
//   node sessions.mjs search <关键词> [--source ...] [--limit 20] [--cwd <子串>] [--json]
//   node sessions.mjs export [<会话 id 或文件路径>] [--current] [--out DIR] [--stdout] [--full]
//                            [--json] [--redact off|home|strict] [--within 分钟]
//   node sessions.mjs dump   [--jsonl|--json] [--source ...] [--since <日期|7d|毫秒>] [--out FILE]
//                            [--full] [--redact ...] [--skip-types a,b]
//
// export 不给目标时导当前会话：先认宿主 agent 的会话标识环境变量，
// 认不出再按工作目录和最近活跃时间挑，挑中哪个会打印出来。
//
// 和 read.mjs 的分工：那个处理别人发来的分享链接，这个读你自己机器上的会话文件。
import { readdir, stat, writeFile, mkdir } from 'node:fs/promises';
import { createWriteStream, existsSync } from 'node:fs';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import * as claudeLocal from './lib/local/claude.mjs';
import * as codexLocal from './lib/local/codex.mjs';
import * as piLocal from './lib/local/pi.mjs';
import * as cursorLocal from './lib/local/cursor.mjs';
import * as zcodeLocal from './lib/local/zcode.mjs';
import * as geminiCliLocal from './lib/local/gemini-cli.mjs';
import * as qwenLocal from './lib/local/qwen.mjs';
import * as clineLocal from './lib/local/cline.mjs';
import * as opencodeLocal from './lib/local/opencode.mjs';
import * as hermesLocal from './lib/local/hermes.mjs';
import * as workbuddyLocal from './lib/local/workbuddy.mjs';
import { makeParser } from './lib/local/jsonl-generic.mjs';
import { lines as readLines, readText } from './lib/local/zst.mjs';
import { buildDoc, safeName, normalizeMessages } from './lib/md.mjs';
import { expandShards, stitchMessages, dedupeShards } from './lib/merge.mjs';
import { createRedactor } from './lib/redact.mjs';
import { t, role as rn } from './lib/i18n.mjs';
import { messageRecord, parseSince } from './lib/provenance.mjs';
import { machineRole } from './lib/roles.mjs';

// CSR_HOME 只给测试用：把各个源的根目录指到一个假家目录里，才能用真文件跑回归。
const home = process.env.CSR_HOME || os.homedir();

// kind: jsonl 每个会话一个文件（或目录树），sqlite 用自带 list/parse 的实现
const SOURCES = {  claude: {
    kind: 'jsonl',
    label: 'Claude Code',
    root: path.join(home, '.claude', 'projects'),
    parser: claudeLocal,
  },
  // 归档会话在 archived_sessions，压缩成 .jsonl.zst，且 Codex 会把读过的会话
  // 解压搬回 sessions 下，两个目录都要扫，否则归档的历史对话搜不到。
  codex: {
    kind: 'jsonl',
    label: 'Codex CLI',
    roots: [path.join(home, '.codex', 'sessions'), path.join(home, '.codex', 'archived_sessions')],
    parser: codexLocal,
  },
  pi: {
    kind: 'jsonl',
    label: 'pi',
    root: path.join(home, '.pi', 'agent', 'sessions'),
    parser: piLocal,
  },
  omp: {
    kind: 'jsonl',
    label: 'Oh My Pi',
    root: path.join(home, '.omp', 'agent', 'sessions'),
    parser: piLocal,
  },
  cursor: { kind: 'sqlite', label: 'Cursor', parser: cursorLocal },
  zcode: { kind: 'sqlite', label: 'zcode', parser: zcodeLocal },
  opencode: { kind: 'sqlite', label: 'opencode', parser: opencodeLocal },
  hermes: { kind: 'sqlite', label: 'Hermes', parser: hermesLocal },

  // WorkBuddy 每条会话一个 jsonl，父目录名是工作区 slug；同级的 <sessionId>/
  // 子目录放工具输出，必须排除，否则会把 tool-results 当成会话。
  workbuddy: {
    kind: 'jsonl',
    label: 'WorkBuddy',
    root: path.join(home, '.workbuddy', 'projects'),
    filter: (f) => /\.jsonl$/.test(f) && !/[\\/]tool-results[\\/]/.test(f),
    parser: workbuddyLocal,
  },

  // 以下源的路径与格式取自 deja-vu 的 registry（社区观测记录），本机无可验证样本
  'gemini-cli': {
    kind: 'jsonl',
    label: 'Gemini CLI',
    root: path.join(home, '.gemini', 'tmp'),
    filter: (f) => /[\\/]chats[\\/][^\\/]+\.jsonl?$/.test(f),
    parser: geminiCliLocal,
  },
  qwen: {
    kind: 'jsonl',
    label: 'Qwen Code',
    root: path.join(home, '.qwen', 'projects'),
    filter: (f) => /[\\/]chats[\\/][^\\/]+\.jsonl$/.test(f),
    parser: qwenLocal,
  },
  cline: {
    kind: 'jsonl',
    label: 'Cline',
    root: path.join(home, '.cline', 'data', 'sessions'),
    filter: (f) => /\.messages\.json$/.test(f),
    refOf: (f) => ({ messagesFile: f, metaFile: f.replace(/\.messages\.json$/, '.json') }),
    parser: clineLocal,
  },
  copilot: {
    kind: 'jsonl',
    label: 'Copilot CLI',
    root: path.join(home, '.copilot', 'session-state'),
    filter: (f) => /events\.jsonl$/.test(f),
    parser: { parse: makeParser('Copilot') },
  },
  commandcode: {
    kind: 'jsonl',
    label: 'Command Code',
    root: path.join(home, '.commandcode', 'projects'),
    filter: (f) => /\.jsonl$/.test(f),
    parser: { parse: makeParser('Command Code') },
  },
  kimi: {
    kind: 'jsonl',
    label: 'Kimi Code',
    root: path.join(home, '.kimi-code', 'sessions'),
    filter: (f) => /wire\.jsonl$/.test(f),
    parser: { parse: makeParser('Kimi') },
  },
  antigravity: {
    kind: 'jsonl',
    label: 'Antigravity',
    root: path.join(home, '.gemini'),
    filter: (f) => /transcript\.jsonl$/.test(f),
    parser: { parse: makeParser('Antigravity') },
  },
};

async function walk(dir, out = [], filter) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out, filter);
    else if (filter ? filter(p) : /\.jsonl(\.zst)?$/.test(e.name)) out.push(p);
  }
  return out;
}

// 文件名里最后一段 UUID 就是会话 id，列表和 export 都用它匹配。
// 归档/压缩后的会话是 `<id>.jsonl.zst`，后缀要一起剥掉。
function idOfFile(file) {
  const base = path.basename(file).replace(/\.jsonl(\.zst)?$/i, '');
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/gi);
  return m && m.length ? m[m.length - 1] : base;
}

// Codex 的 fork 分片名形如 `<父线程>_<新线程>.jsonl`，父线程 id 是第一个 UUID。
// 合并一个会话的所有分片时要按它归组。
function familyOfFile(file) {
  const base = path.basename(file).replace(/\.jsonl(\.zst)?$/i, '');
  const m = base.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i);
  return m ? m[1] : base;
}

// 注入型消息：文件内容包裹、系统提示片段，不能当标题
function isInjected(text) {
  const t = String(text || '').trim();
  return t.startsWith('<') || t.length < 4;
}

function tidy(t) {
  return String(t || '')
    .replace(/[#*`>\n]/g, ' ')
    .replace(/[，。、？！；："'（）《》…—\s]+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
}

// 只读文件前部找标题，避免为了列表把所有会话全解析一遍。
// 走 zst.mjs 的行迭代，压缩会话也能取到标题，且不会把整个大文件读进内存。
async function* headLines(file, max = 500) {
  let n = 0;
  for await (const line of readLines(file)) {
    yield line;
    if (++n >= max) return;
  }
}

// 会话真正的线程 id 在文件里，不在文件名上。Codex 的 fork 分片会用新 id 命名，
// 但 session_meta 仍然复制父线程的 id，所以合并分片只能靠它。
//
// 同时带出会话类型：Codex 的 thread_source 是 user / subagent / guardian_review。
// guardian_review 那批是审批回执（正文是 {"risk_level":...} 的 JSON），没有任何对话，
// 批量导出要按类型直接跳过；不能拿「解析后 0 条消息」当判据，那和损坏文件分不开。
// 只读前几行，不解析整个文件。
async function sessionMetaOf(file) {
  const meta = { sessionId: '', type: '', agentPath: '', startAt: '' };
  try {
    for await (const line of headLines(file, 5)) {
      const s = line.trim();
      if (!s) continue;
      let j;
      try {
        j = JSON.parse(s);
      } catch {
        continue;
      }
      if (j.type === 'session_meta' && j.payload) {
        meta.sessionId = j.payload.session_id || j.payload.id || '';
        meta.type = j.payload.thread_source || '';
        meta.agentPath = j.payload.agent_path || '';
        meta.startAt = j.payload.timestamp || '';
        // 老版本没有 thread_source，但 payload.source.subagent 存在同样说明是子会话
        if (!meta.type && j.payload.source && j.payload.source.subagent) meta.type = 'subagent';
        return meta;
      }
      if (j.type === 'session-meta' && j.sessionId) {
        meta.sessionId = j.sessionId;
        return meta;
      }
    }
  } catch {
    /* 读不动就当没有 meta */
  }
  return meta;
}

async function sessionIdOf(file) {
  return (await sessionMetaOf(file)).sessionId;
}

async function peekJsonl(file, name) {
  let fallback = '';
  try {
    for await (const line of headLines(file)) {
      const s = line.trim();
      if (!s) continue;
      let j;
      try {
        j = JSON.parse(s);
      } catch {
        continue;
      }
      if (name === 'claude') {
        if (j.type !== 'user' || j.isSidechain) continue;
        const c = j.message && j.message.content;
        const text =
          typeof c === 'string'
            ? c
            : Array.isArray(c)
              ? c.map((x) => (x && x.text) || '').join(' ')
              : '';
        if (text.trim()) return tidy(text);
      } else if (name === 'codex') {
        if (j.type !== 'event_msg' || !j.payload || j.payload.type !== 'item_completed') continue;
        const it = j.payload.item || {};
        if (it.type !== 'UserMessage') continue;
        const text = (it.content || []).map((c) => (c && (c.text || c.Text)) || '').join(' ');
        if (text.trim()) return tidy(text);
      } else if (name === 'workbuddy') {
        if (j.type !== 'message' || j.role !== 'user') continue;
        const text = (Array.isArray(j.content) ? j.content : [])
          .map((c) => (c && typeof c.text === 'string' ? c.text : ''))
          .join(' ')
          .replace(/<system-reminder[\s\S]*?<\/system-reminder>/g, '')
          .replace(/<\/?user_query>/g, '');
        if (isInjected(text)) {
          if (!fallback && text.trim()) fallback = tidy(text);
          continue;
        }
        if (text.trim()) return tidy(text);
      } else {
        // pi / omp
        if (j.type === 'title' && (j.title || j.text)) return tidy(j.title || j.text);
        if (j.type !== 'message') continue;
        const m = j.message || {};
        if (m.role !== 'user') continue;
        const text = Array.isArray(m.content)
          ? m.content.map((c) => (c && c.text) || '').join(' ')
          : String(m.content || '');
        // 首条常是 <file name=...> 这类注入，不是真实提问，跳过；全被跳过时回退到它
        if (isInjected(text)) {
          if (!fallback && text.trim()) fallback = tidy(text);
          continue;
        }
        if (text.trim()) return tidy(text);
      }
    }
  } catch {
    /* 读不动就当没标题 */
  }
  return fallback;
}

async function discover(names, limit = 200) {
  const items = [];

  for (const name of names) {
    const cfg = SOURCES[name];
    if (!cfg) continue;

    if (cfg.kind === 'sqlite') {
      try {
        const rows = await cfg.parser.list({ limit });
        for (const r of rows) items.push({ ...r, name });
      } catch {
        /* 这个源不可用就跳过 */
      }
      continue;
    }

    if (!existsSync(cfg.root) && !(cfg.roots || []).some((r) => existsSync(r))) continue;
    const roots = cfg.roots || [cfg.root];
    for (const root of roots) {
      if (!existsSync(root)) continue;
      for (const f of await walk(root, [], cfg.filter)) {
        let st;
        try {
          st = await stat(f);
        } catch {
          continue;
        }
        items.push({
          source: name,
          name,
          id: idOfFile(f),
          family: familyOfFile(f),
          time: timeFromName(f) || st.mtimeMs,
          mtime: st.mtimeMs,
          size: Math.round(st.size / 1024) + 'K',
          bytes: st.size,
          ref: cfg.refOf ? cfg.refOf(f) : f,
          file: f,
        });
      }
    }
  }

  // 标题要读文件，几千个会话逐个读太贵，交给 list 截断后再取
  return items.sort((a, b) => b.time - a.time);
}

function fmtTime(value) {
  if (!value) return '';
  const ms = typeof value === 'number' ? value : new Date(value).getTime();
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = {
    source: 'all',
    limit: 20,
    cwd: '',
    out: '',
    stdout: false,
    full: false,
    json: false,
    current: false,
    redact: 'home',
    within: 60,
    since: '',
    jsonl: false,
    skipTypes: [...DEFAULT_SKIP_TYPES].join(','),
    noSkip: false,
    limitSet: false,
  };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--source') opts.source = rest[++i];
    else if (a === '--limit') {
      opts.limit = Number(rest[++i]);
      opts.limitSet = true;
    }
    else if (a === '--cwd') opts.cwd = rest[++i] || '';
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '--stdout') opts.stdout = true;
    else if (a === '--full') opts.full = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--current') opts.current = true;
    else if (a === '--redact') opts.redact = rest[++i] || 'home';
    else if (a === '--no-redact') opts.redact = 'off';
    else if (a === '--within') opts.within = Number(rest[++i]) || 60;
    else if (a === '--since') opts.since = rest[++i] || '';
    else if (a === '--jsonl') opts.jsonl = true;
    else if (a === '--skip-types') opts.skipTypes = rest[++i] || '';
    else if (a === '--no-skip') opts.noSkip = true;
    else positional.push(a);
  }
  const names = opts.source === 'all' ? Object.keys(SOURCES) : [opts.source];
  return { cmd, positional, opts, names };
}

async function cmdList(opts, names) {
  let items = await discover(names, opts.limit);
  if (opts.cwd) {
    const kept = [];
    for (const it of items) {
      if (await matchCwd(it, opts.cwd)) kept.push(it);
    }
    items = kept;
  }
  items = items.slice(0, opts.limit);
  for (const it of items) {
    it.title = await peekJsonl(it.ref, it.name).catch(() => '');
  }
  if (opts.json) {
    return console.log(
      JSON.stringify(
        items.map((x) => ({
          source: x.name,
          id: x.id || idOfFile(x.ref),
          time: fmtTime(x.time),
          title: x.title || t('(无标题)', '(untitled)'),
          count: x.count,
          ref: x.file || x.ref,
        })),
        null,
        2
      )
    );
  }
  if (!items.length) return console.log(t('没有找到任何会话', 'No sessions found'));
  // 按时间混排时同源不连续，分组标题会重复出现，改成每行带来源
  for (const x of items) {
    const id = x.id ? String(x.id) : idOfFile(x.ref);
    const size = x.size || (x.count ? x.count + t('条', '') : '');
    const src = String(SOURCES[x.name].label || x.name).padEnd(11);
    console.log(`${fmtTime(x.time)}  ${src} ${String(size).padStart(7)}  ${id}  ${x.title || t('(无标题)', '(untitled)')}`);
  }
}

// 关键词只匹配对话正文，不匹配文件原文。
//
// 原来的实现直接对 jsonl 原文 indexOf，会把 role=developer 的系统提示和记忆注入
// 当成命中：记忆里写过一次项目路径，就能让几十个无关会话全部命中。所以这里先
// parse 出 messages，再在 body 里找。
//
// 代价是要读文件。普通文件先用原文预筛一次压掉大部分无关会话；压缩会话跳过
// 预筛直接 parse，避免解压两遍。
function snippet(text, keyword, span = 60) {
  const i = text.indexOf(keyword);
  if (i < 0) return '';
  return text
    .slice(Math.max(0, i - span), i + keyword.length + span)
    .replace(/\s+/g, ' ')
    .trim();
}

// 文件名里带 ISO 时间的源（codex 的 rollout-2026-10-05T22-24-13、pi 的 2026-11-01T13-34-07）
// 优先用它，因为归档 .zst 的 mtime 是解压时间，按 mtime 排会把旧会话顶到最前。
function timeFromName(file) {
  const m = path.basename(file).match(/(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})/);
  if (!m) return 0;
  const t = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}`).getTime();
  return Number.isFinite(t) ? t : 0;
}

// Windows 上 cwd 存的是反斜杠，用户敲的可能是正斜杠，两边都归一化再比
function normPath(p) {
  return String(p || '').replace(/\\/g, '/').toLowerCase();
}

async function matchCwd(item, needle) {
  const lower = normPath(needle);
  if (item.meta && normPath(item.meta.cwd).includes(lower)) return true;
  if (normPath(item.file).includes(lower)) return true;
  // 有些源（WorkBuddy）把会话按工作区 slug 分目录，目录名是 cwd 转写来的，
  // 路径里没有可读的工作目录，只能按 slug 比。
  if (item.file && path.basename(path.dirname(item.file)) === slugOfCwd(needle)) return true;
  // 路径里没写工作目录的源（codex/claude），读头几行的 cwd
  try {
    for await (const line of headLines(item.file, 5)) {
      const s = line.trim();
      if (!s) continue;
      let j;
      try {
        j = JSON.parse(s);
      } catch {
        continue;
      }
      const cwd = (j.payload && j.payload.cwd) || j.cwd;
      if (cwd) return normPath(cwd).includes(lower);
    }
  } catch {
    /* 读不动就按不匹配处理 */
  }
  return false;
}

// E:\01-project\00-workspace -> e-01-project-00-workspace
function slugOfCwd(p) {
  return String(p || '')
    .toLowerCase()
    .replace(/[\\/:]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

// 认当前会话。两条依据，先准确后兜底：
//   1. 宿主 agent 把自己的会话 id 传进环境变量，最准
//   2. 没有环境变量时，按工作目录匹配 + 最近活跃时间挑一个
// 第二条是启发式的：同一个目录同时开着两个 agent 会话时可能挑错，所以挑中哪个要报出来。
const CURRENT_ENV = [
  ['workbuddy', ['CODEBUDDY_SESSION_ID', 'WORKBUDDY_SESSION_ID']],
  ['claude', ['CLAUDE_SESSION_ID', 'CLAUDE_CODE_SESSION_ID']],
  ['codex', ['CODEX_THREAD_ID', 'CODEX_SESSION_ID']],
  ['qwen', ['QWEN_SESSION_ID']],
  ['kimi', ['KIMI_SESSION_ID']],
  ['gemini-cli', ['GEMINI_SESSION_ID']],
  ['cursor', ['CURSOR_SESSION_ID']],
];

async function findCurrent(opts, names) {
  const available = SESSION_ENV_SCAN(names);

  for (const [name, vars] of available) {
    for (const v of vars) {
      const id = String(process.env[v] || '').trim();
      if (!id || id.length < 6) continue;
      const items = await discover([name]);
      const hit = items.filter(
        (x) => String(x.id || '').includes(id) || String(x.file || x.ref || '').includes(id)
      );
      if (hit.length) return { picked: hit, items, how: `${name} ${id} · ${v}` };
    }
  }

  const items = await discover(names);
  const windowMs = Math.max(1, opts.within || 60) * 60000;
  const now = Date.now();
  const recent = items.filter((x) => now - x.time <= windowMs);
  if (!recent.length) {
    throw new Error(
      t(
        `最近 ${opts.within} 分钟内没有活跃会话，用 list 找一个再指定 id`,
        `No session active within ${opts.within} min; run list and pass an id`
      )
    );
  }

  const cwd = opts.cwd || process.cwd();
  const matched = [];
  for (const it of recent.slice(0, 20)) {
    if (await matchCwd(it, cwd)) matched.push(it);
  }
  const pool = matched.length ? matched : recent;
  const seed = pool[0];
  return {
    picked: [seed],
    items,
    how: `${seed.source} ${seed.id} · ${cwd} · ${matched.length ? 'cwd' : 'recent'}`,
  };
}

function SESSION_ENV_SCAN(names) {
  return CURRENT_ENV.filter(([name]) => names.includes(name));
}

async function cmdSearch(keyword, opts, names) {
  if (!keyword) throw new Error(t('要给一个关键词', 'A keyword is required'));
  const items = await discover(names);
  const hits = [];
  const failed = [];

  for (const it of items) {
    if (hits.length >= opts.limit) break;
    if (opts.cwd && !(await matchCwd(it, opts.cwd))) continue;

    const compressed = /\.zst$/i.test(it.file || '');
    if (!compressed) {
      const raw = await readText(it.file).catch(() => '');
      if (!raw.includes(keyword)) continue;
    }

    const cfg = SOURCES[it.name];
    let parsed;
    try {
      parsed = await cfg.parser.parse(it.ref);
    } catch (e) {
      failed.push({ file: it.file, error: String(e.message || e) });
      continue;
    }
    const matched = parsed.messages.filter((m) => m.body.includes(keyword));
    if (!matched.length) continue;
    // 文件 mtime 会被压缩、重写改掉，展示用会话内第一条消息的时间
    const startedAt = parsed.messages.find((m) => m.at)?.at || '';
    hits.push({ ...it, title: parsed.title, meta: parsed.meta, matched, startedAt });
  }

  if (opts.json) {
    return console.log(
      JSON.stringify(
        hits.map((h) => ({
          source: h.source,
          id: h.id,
          title: h.title,
          time: fmtTime(h.startedAt || h.time),
          cwd: (h.meta && h.meta.cwd) || '',
          ref: h.file || h.ref,
          matched: h.matched.map((m) => ({
            role: machineRole(m.role),
            speaker: rn(m.role),
            time: m.time,
            snippet: snippet(m.body, keyword),
          })),
        })),
        null,
        2
      )
    );
  }

  if (!hits.length) {
    console.log(t('没有命中', 'no matches'));
    if (failed.length) console.log(t(`（${failed.length} 个会话解析失败，可用 --source 缩小范围重试）`, `(${failed.length} sessions failed to parse; narrow with --source and retry)`));
    return;
  }
  for (const h of hits) {
    console.log(
      `${fmtTime(h.startedAt || h.time)}  ${String(h.source).padEnd(9)} ${t('命中', 'hits')} ${h.matched.length}  「${h.title || t('(无标题)', '(untitled)')}」`
    );
    for (const m of h.matched.slice(0, 3)) {
      console.log(`  ${rn(m.role)}: ${snippet(m.body, keyword)}`);
    }
    if (h.matched.length > 3) console.log(`  …另有 ${h.matched.length - 3} 条`);
    console.log(`  ${h.file || h.ref}`);
  }
  if (failed.length) console.log(`\n${failed.length} 个会话解析失败：${failed.map((f) => path.basename(f.file)).join(', ')}`);
}

// 直接给文件路径时，先按目录名认源；认不出再看内容特征。
// 目录判断要做分隔符归一化，Windows 上传进来的路径常是正斜杠。
async function guessSource(file) {
  const norm = String(file).replace(/\\/g, '/');
  for (const n of ['codex', 'claude', 'omp', 'pi', 'workbuddy']) {
    if (norm.includes(`/.${n}/`)) return n;
  }
  try {
    for await (const line of headLines(file, 3)) {
      const s = line.trim();
      if (!s) continue;
      if (s.includes('"type":"session-meta"')) return 'workbuddy';
      if (s.includes('"type":"session_meta"')) return 'codex';
      if (/"type":"(user|assistant)"/.test(s)) return 'claude';
    }
  } catch {
    /* 读不动就按默认 */
  }
  return 'claude';
}

// 默认不进对话流的会话类型。Codex 的 guardian_review 是审批回执（正文是
// {"risk_level":...}），它挂在父会话的 session_id 上，按会话归组时会混进父会话，
// 只能按文件类型单独剔。export 和 dump 共用这一份名单。
const DEFAULT_SKIP_TYPES = new Set(['guardian_review']);

function skipReason(type) {
  if (type === 'guardian_review') {
    return t(
      '这是 Codex 的 guardian_review 审批子会话，整份只有审批回执，没有对话可导',
      'This is a Codex guardian_review approval subsession: approval verdicts only, no conversation to export'
    );
  }
  return t(
    `这是 ${type} 类型的子会话，没有可导出的对话`,
    `This is a ${type} subsession with no conversation to export`
  );
}

// 「0 条消息」有两种来源，要分开报：审批/子会话类型本来就没有对话，不是解析
// 坏了；其他情况才说明格式变了或者文件是空壳。
async function emptyReason(picked) {
  const file = picked[0] && (picked[0].file || String(picked[0].ref));
  const meta = file ? await sessionMetaOf(file).catch(() => null) : null;
  if (meta && meta.type) return skipReason(meta.type);
  return t('这个会话里没有可导出的对话', 'This session has no exportable messages');
}

async function cmdExport(target, opts, names) {
  // 不给目标就是导当前会话。零参数是 agent 在会话里最自然的用法：
  // 「把这段对话存下来」，不应该要求它先去 list 查一个 id。
  const wantCurrent = opts.current || !target;
  let picked = [];
  // seed 是用户点名（或自动选中）的那一场，扩展分片前先记下来：
  // dedupeShards 会按时间重排，扩完 picked[0] 已经不一定是它了。
  let seed = null;

  if (wantCurrent) {
    const cur = await findCurrent(opts, names);
    console.error(t(`当前会话：${cur.how}`, `current session: ${cur.how}`));
    seed = cur.picked[0];
    picked = await expandShards(cur.picked, cur.items, sessionIdOf, { deep: true });
  } else if (existsSync(target)) {
    const name = await guessSource(target);
    seed = { name, ref: target, file: target, time: 0 };
    picked = [seed];
  } else {
    const items = await discover(names);
    const matched = items.filter(
      (x) =>
        (x.id && String(x.id).includes(target)) ||
        (x.family && String(x.family).includes(target)) ||
        (x.ref && typeof x.ref === 'string' && path.basename(x.ref).includes(target))
    );
    if (!matched.length) throw new Error(t('找不到匹配的会话：', 'No matching session: ') + target);
    seed = matched[0];
    picked = await expandShards(matched, items, sessionIdOf, { deep: true });
  }

  // 审批类分片挂在父会话的 session_id 上，扩展分片时会被一起收进来。
  // 分两种处理：点名要的就是它，直接说清楚没有对话；顺带收进来的，剔掉。
  const seedMeta = seed.file ? await sessionMetaOf(seed.file).catch(() => null) : null;
  if (seedMeta && DEFAULT_SKIP_TYPES.has(seedMeta.type)) throw new Error(skipReason(seedMeta.type));
  if (picked.length > 1) {
    const seedKey = seed.file || String(seed.ref);
    const kept = [];
    for (const p of picked) {
      const file = p.file || String(p.ref);
      if (file === seedKey || !p.file) {
        kept.push(p);
        continue;
      }
      const m = await sessionMetaOf(p.file).catch(() => null);
      if (m && DEFAULT_SKIP_TYPES.has(m.type)) continue;
      kept.push(p);
    }
    picked = kept;
  }

  const cfg = SOURCES[picked[0].name];
  if (!cfg) throw new Error(t('未知来源：', 'Unknown source: ') + picked[0].name);

  // 分片来源挂在消息上。合并、去重、排序之后仍要能回答「这条出自哪个文件」，
  // 下游拿它对回原文；脱敏不作用于这个字段，它是句柄不是内容。
  const parts = [];
  for (const p of picked) {
    const file = p.file || String(p.ref);
    const parsed = await cfg.parser.parse(p.ref, { full: opts.full });
    parts.push({
      ...parsed,
      messages: (parsed.messages || []).map((m) => ({ ...m, shard: file })),
    });
  }

  const merged = stitchMessages(parts);
  const messages = normalizeMessages(merged.messages);
  const note = merged.note;
  if (!messages.length) throw new Error(await emptyReason(picked));

  const first = messages.find((m) => m.role === '用户');
  const title = (first ? first.body : messages[0].body)
    .replace(/[#*`>\n]/g, ' ')
    .replace(/[，。、？！；："'（）《》…—\s]+/g, ' ')
    .trim()
    .slice(0, 24)
    .trim();

  // 标题里常带路径（第一句就是「帮我看看 C:\Users\x\... 报错」），
  // 落成文件名前也要过一遍脱敏，否则用户名会留在文件名上。
  const r = createRedactor(opts.redact);
  const safeTitle = r.apply(title);

  if (opts.json) {
    // 会话级定位：线程 id 从解析结果里取，取不到退回文件名里的 UUID。
    // Codex 的 fork 分片也带父线程 id，所以同一场对话的两个文件拿到的是同一个 session。
    const session =
      (parts.find((p) => p && p.meta && p.meta.sessionId) || {}).meta?.sessionId ||
      picked[0].id ||
      idOfFile(picked[0].file || '') ||
      '';
    const meta0 = picked[0].file ? await sessionMetaOf(picked[0].file).catch(() => null) : null;
    const segments = picked.map((p) => p.file || String(p.ref));

    return console.log(
      JSON.stringify(
        {
          source: picked[0].name,
          session,
          session_type: (meta0 && meta0.type) || '',
          title: safeTitle,
          // segments 是给下游继续读文件的句柄，保持原样不脱敏；
          // 脱敏只作用于会被展示、复制、分享的内容字段。
          segments,
          redact: r.level,
          messages: messages.map((m, i) => {
            const body = r.apply(m.body);
            const shard = m.shard || segments[0];
            return {
              ...messageRecord({
                source: picked[0].name,
                session,
                shard,
                shardIndex: Math.max(0, segments.indexOf(shard)),
                shardCount: segments.length,
                index: i,
                message: m,
                body,
              }),
              body,
            };
          }),
        },
        null,
        2
      )
    );
  }

  const md = buildDoc({
    title,
    url: picked.map((p) => p.file || String(p.ref)).join('\n  '),
    source: picked.length > 1 ? `合并 ${picked.length} 个分片` : '',
    channel: 'local/' + picked[0].name,
    messages,
    note,
    redact: opts.redact,
  });

  if (opts.stdout) return console.log(md);
  // dump 用 --out / stdout，export 不给就是 ./sessions；两者共用 opts.out，
  // 所以默认值留空，别在这里以外的地方假定它已经有值。
  const outDir = opts.out || './sessions';
  await mkdir(outDir, { recursive: true });
  const out = path.resolve(outDir, safeName(safeTitle) + '.md');
  await writeFile(out, md, 'utf8');
  console.log(
    `OK ${picked[0].name} ${messages.length} 条${picked.length > 1 ? `（合并 ${picked.length} 个分片）` : ''}${opts.redact === 'off' ? '' : t(` · 脱敏 ${opts.redact}`, ` · redacted ${opts.redact}`)} -> ${out}`
  );
}

// 批量导出：一场会话一个 family，流式往外写、不在内存里攒。
//
// 为什么按 family 归组而不是一个文件一条：Codex 的 fork 会把父线程的历史整段复制
// 进新文件，逐个文件导会让同一句话出现多遍。归组键用文件里的线程 id
// （session_meta.session_id），不用文件名，因为分片名用的是新 id。跟 export 一致：
// 同一场对话无论拆分几个文件，导出结果里只出现一次，分片信息标在每条记录上。
//
// 会话类型（session_meta.thread_source）是文件级属性，在解析前判。Codex 的
// guardian_review 审批子会话是挂在父会话上的分片（session_id 与父会话相同），
// 整份只有 {"risk_level":...} 审批回执。等到解析完再拿「0 条消息」当判据，
// 就分不清它和真正损坏的文件，也会让 227 个空分片混进父会话的处理里。
async function cmdDump(opts, names) {
  const since = opts.since ? parseSince(opts.since) : 0;
  const skip = new Set(
    (opts.noSkip ? '' : opts.skipTypes)
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const limit = opts.limitSet ? opts.limit : 1000000;
  const all = await discover(names, limit);
  // 没有文件的源（SQLite）没有 mtime，用会话自己的时间
  const items = since ? all.filter((it) => (it.mtime || it.time || 0) >= since) : all;

  // 归组：JSONL 按线程 id 归，SQLite 每条本来就已经是一场会话
  const groups = new Map();
  const skipped = {};
  for (const it of items) {
    const cfg = SOURCES[it.name];
    if (!cfg) continue;
    if (cfg.kind === 'sqlite') {
      const key = `${it.name}:${it.id}`;
      groups.set(key, {
        key,
        source: it.name,
        session: String(it.id || ''),
        time: it.time || 0,
        type: '',
        shards: [{ ...it, meta: null }],
      });
      continue;
    }
    const file = it.file;
    if (!file) continue;
    const meta = await sessionMetaOf(file);
    // 文件级跳过：guardian_review 这类分片整份没有对话，不必读全文
    if (meta.type && skip.has(meta.type)) {
      skipped[meta.type] = (skipped[meta.type] || 0) + 1;
      continue;
    }
    const session = meta.sessionId || it.id || idOfFile(file);
    const key = `${it.name}:${session}`;
    let g = groups.get(key);
    if (!g) {
      g = { key, source: it.name, session, time: it.time || 0, type: '', shards: [] };
      groups.set(key, g);
    }
    g.shards.push({ ...it, meta });
    g.time = Math.max(g.time, it.time || 0, it.mtime || 0);
  }

  // 类型跟最早的分子走：父会话先建，fork 后建，先建的那个才是这场对话的类型
  for (const g of groups.values()) {
    if (SOURCES[g.source].kind === 'sqlite') continue;
    g.shards.sort((a, b) => (a.time || 0) - (b.time || 0));
    g.type = (g.shards[0].meta && g.shards[0].meta.type) || '';
  }

  const out = opts.out
    ? createWriteStream(path.resolve(opts.out), { encoding: 'utf8' })
    : process.stdout;
  if (out === process.stdout) {
    // 被 | head 截断时不要报 EPIPE 退出码
    process.stdout.on('error', (e) => {
      if (e.code !== 'EPIPE') throw e;
    });
  }
  // 管道被下游关掉（| head）时算正常结束：不再继续导，也不报错退出。
  // 光挂一个 error 监听不够，once(out, 'drain') 会把同一个 EPIPE 变成 rejection。
  let broken = false;
  const write = async (obj) => {
    if (broken) return false;
    try {
      if (!out.write(JSON.stringify(obj) + '\n')) await once(out, 'drain');
      return true;
    } catch (e) {
      if (e.code === 'EPIPE') {
        broken = true;
        return false;
      }
      throw e;
    }
  };

  const r = createRedactor(opts.redact);
  let sessions = 0;
  let messagesOut = 0;
  let skippedEmpty = 0;
  const failures = [];

  const order = [...groups.values()].sort((a, b) => (b.time || 0) - (a.time || 0));
  for (const g of order) {
    if (broken) break;
    const cfg = SOURCES[g.source];
    const shards = dedupeShards(g.shards);
    const parts = [];
    for (const [i, s] of shards.entries()) {
      const file = s.file || String(s.ref);
      try {
        const parsed = await cfg.parser.parse(s.ref, { full: opts.full });
        parts.push({
          ...parsed,
          messages: (parsed.messages || []).map((m) => ({
            ...m,
            shard: file,
            shardIndex: i,
            shardType: (s.meta && s.meta.type) || '',
          })),
        });
      } catch (e) {
        failures.push({ source: g.source, session: g.session, shard: file, error: String(e.message || e) });
      }
    }
    const merged = stitchMessages(parts);
    const messages = normalizeMessages(merged.messages);
    if (!messages.length) {
      skippedEmpty++;
      continue;
    }

    sessions++;
    messagesOut += messages.length;
    const startedAt = messages.find((m) => m.at)?.at || '';
    const recOf = (m, i, body) => ({
      ...messageRecord({
        source: g.source,
        session: g.session,
        family: g.session,
        shard: m.shard || shards[0].file || String(shards[0].ref),
        shardIndex: m.shardIndex || 0,
        shardCount: shards.length,
        index: i,
        message: m,
        body,
      }),
      session_type: g.type || '',
      shard_type: m.shardType || '',
      started_at: startedAt,
    });

    if (opts.json) {
      await write({
        kind: 'session',
        source: g.source,
        family: g.session,
        session: g.session,
        session_type: g.type || '',
        shards: shards.map((s) => s.file || String(s.ref)),
        started_at: startedAt,
        msg_count: messages.length,
        messages: messages.map((m, i) => {
          const body = r.apply(m.body);
          return { ...recOf(m, i, body), body };
        }),
      });
      continue;
    }

    for (const [i, m] of messages.entries()) {
      const body = r.apply(m.body);
      await write({ kind: 'message', ...recOf(m, i, body), body });
    }
  }

  if (out !== process.stdout) await new Promise((res) => out.end(res));

  const span = since ? t(`（mtime ≥ ${new Date(since).toISOString()}）`, ` (mtime >= ${new Date(since).toISOString()})`) : '';
  const skipDetail = Object.entries(skipped)
    .map(([k, n]) => `${k} ${n}`)
    .join(', ');
  const skippedTotal = Object.values(skipped).reduce((n, v) => n + v, 0);
  console.error(
    t(
      `完成：${sessions} 场会话，${messagesOut} 条消息，按类型跳过 ${skippedTotal} 个分片${skipDetail ? `（${skipDetail}）` : ''}，空会话 ${skippedEmpty} 个${failures.length ? `，${failures.length} 个分片解析失败` : ''}${span}`,
      `done: ${sessions} sessions, ${messagesOut} messages, ${skippedTotal} shards skipped by type${skipDetail ? ` (${skipDetail})` : ''}, ${skippedEmpty} empty${failures.length ? `, ${failures.length} shards failed` : ''}${span}`
    )
  );
  for (const f of failures.slice(0, 5)) {
    console.error(`  FAIL ${f.source} ${f.session} ${path.basename(f.shard)} :: ${f.error}`);
  }
}

function cmdSources() {
  for (const [name, cfg] of Object.entries(SOURCES)) {
    const roots = cfg.roots || (cfg.root ? [cfg.root] : []);
    let where = roots.join('  +  ');
    let state = '';
    if (cfg.kind === 'sqlite') {
      where = (cfg.parser.dbPath && cfg.parser.dbPath()) || '(未找到数据库)';
      state = where.startsWith('(') ? t('未安装', 'absent') : t('可用', 'usable');
    } else {
      state = roots.some((r) => existsSync(r)) ? t('有目录', 'found') : t('无目录', 'missing');
    }
    console.log(`${name.padEnd(7)} ${cfg.label.padEnd(12)} ${state.padEnd(6)} ${where}`);
  }
}

const { cmd, positional, opts, names } = parseArgs(process.argv.slice(2));

try {
  if (cmd === 'list') await cmdList(opts, names);
  else if (cmd === 'search') await cmdSearch(positional[0], opts, names);
  else if (cmd === 'export') await cmdExport(positional[0], opts, names);
  else if (cmd === 'dump') await cmdDump(opts, names);
  else if (cmd === 'sources') cmdSources();
  else {
    console.error(
      '用法：\n' +
        '  node sessions.mjs sources\n' +
        '  node sessions.mjs list [--source <名字>|all] [--limit 20] [--cwd <子串>] [--json]\n' +
        '  node sessions.mjs search <关键词> [--source ...] [--limit 20] [--cwd <子串>] [--json]\n' +
        '  node sessions.mjs export [<id 或路径>] [--current] [--out DIR] [--stdout] [--full] [--json]\n' +
        '                          [--redact off|home|strict] [--within 60]\n' +
        '  node sessions.mjs dump [--jsonl|--json] [--source <名字>|all] [--since 2026-11-01|7d] [--out FILE]\n' +
        '                        [--full] [--redact off|home|strict] [--skip-types guardian_review] [--no-skip]\n' +
        '\n' +
        'export 不给目标时导当前会话（认宿主 agent 的会话标识，认不出按工作目录 + 最近活跃挑）。\n' +
        'dump 批量导全部会话：--jsonl 一条消息一行，--json 一场会话一行；--since 按文件 mtime 增量。\n' +
        '脱敏默认 home：家目录换成 ~，strict 再遮邮箱、令牌、内网 IP，off 导出原文。'
    );
    process.exit(2);
  }
} catch (e) {
  console.error('FAIL :: ' + String(e.message || e));
  process.exit(1);
}
