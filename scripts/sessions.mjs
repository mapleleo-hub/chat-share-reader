#!/usr/bin/env node
// 本地会话入口：列出、搜索、导出本机各 AI 编码 agent 的会话记录。
//
// 用法：
//   node sessions.mjs sources
//   node sessions.mjs list [--source <名字>|all] [--limit 20] [--json]
//   node sessions.mjs search <关键词> [--source ...] [--limit 20]
//   node sessions.mjs export <会话 id 或文件路径> [--out DIR] [--stdout] [--full]
//
// 和 read.mjs 的分工：那个处理别人发来的分享链接，这个读你自己机器上的会话文件。
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as claudeLocal from './lib/local/claude.mjs';
import * as codexLocal from './lib/local/codex.mjs';
import * as piLocal from './lib/local/pi.mjs';
import * as cursorLocal from './lib/local/cursor.mjs';
import * as zcodeLocal from './lib/local/zcode.mjs';
import { buildDoc, safeName, normalizeMessages } from './lib/md.mjs';

const home = os.homedir();

// kind: jsonl 每个会话一个文件（或目录树），sqlite 用自带 list/parse 的实现
const SOURCES = {
  claude: {
    kind: 'jsonl',
    label: 'Claude Code',
    root: path.join(home, '.claude', 'projects'),
    parser: claudeLocal,
  },
  codex: {
    kind: 'jsonl',
    label: 'Codex CLI',
    root: path.join(home, '.codex', 'sessions'),
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
};

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) await walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

// 文件名里最后一段 UUID 就是会话 id，列表和 export 都用它匹配
function idOfFile(file) {
  const base = path.basename(file, '.jsonl');
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

// 只读文件前部找标题，避免为了列表把所有会话全解析一遍
async function peekJsonl(file, name) {
  const raw = await readFile(file, 'utf8').catch(() => '');
  const lines = raw.split('\n').slice(0, 500);
  let fallback = '';
  for (const line of lines) {
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

    if (!existsSync(cfg.root)) continue;
    for (const f of await walk(cfg.root)) {
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
        time: st.mtimeMs,
        size: Math.round(st.size / 1024) + 'K',
        ref: f,
        file: f,
      });
    }
  }

  for (const it of items) {
    if (it.title === undefined) it.title = await peekJsonl(it.ref, it.name).catch(() => '');
  }

  return items.sort((a, b) => b.time - a.time);
}

function fmtTime(ms) {
  if (!ms) return '';
  const d = new Date(Number(ms));
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const opts = { source: 'all', limit: 20, out: './sessions', stdout: false, full: false, json: false };
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--source') opts.source = rest[++i];
    else if (a === '--limit') opts.limit = Number(rest[++i]);
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '--stdout') opts.stdout = true;
    else if (a === '--full') opts.full = true;
    else if (a === '--json') opts.json = true;
    else positional.push(a);
  }
  const names = opts.source === 'all' ? Object.keys(SOURCES) : [opts.source];
  return { cmd, positional, opts, names };
}

async function cmdList(opts, names) {
  const items = (await discover(names, opts.limit)).slice(0, opts.limit);
  if (opts.json) {
    return console.log(
      JSON.stringify(
        items.map((x) => ({
          source: x.name,
          id: x.id || idOfFile(x.ref),
          time: fmtTime(x.time),
          title: x.title || '(无标题)',
          count: x.count,
          ref: x.file || x.ref,
        })),
        null,
        2
      )
    );
  }
  if (!items.length) return console.log('没有找到任何会话');
  let last = '';
  for (const x of items) {
    if (x.name !== last) {
      console.log('\n[' + SOURCES[x.name].label + ']');
      last = x.name;
    }
    const id = x.id ? String(x.id) : idOfFile(x.ref);
    const size = x.size || (x.count ? x.count + '条' : '');
    console.log(`  ${fmtTime(x.time)}  ${String(size).padStart(7)}  ${id}  ${x.title || '(无标题)'}`);
  }
}

async function cmdSearch(keyword, opts, names) {
  if (!keyword) throw new Error('要给一个关键词');
  const items = await discover(names);
  const hits = [];
  for (const it of items) {
    if (!it.file) continue;
    const raw = await readFile(it.file, 'utf8').catch(() => '');
    const idx = raw.indexOf(keyword);
    if (idx < 0) continue;
    hits.push({
      source: it.name,
      time: fmtTime(it.time),
      file: it.file,
      ctx: raw
        .slice(Math.max(0, idx - 60), idx + keyword.length + 60)
        .replace(/\\n/g, ' ')
        .replace(/\s+/g, ' '),
    });
    if (hits.length >= opts.limit) break;
  }
  if (opts.json) return console.log(JSON.stringify(hits, null, 2));
  if (!hits.length) return console.log('没有命中');
  for (const h of hits) {
    console.log(`${h.time}  ${h.source.padEnd(7)} ${h.ctx}`);
    console.log(`  ${h.file}`);
  }
}

async function cmdExport(target, opts, names) {
  if (!target) throw new Error('要给会话 id 或文件路径');

  let picked = null;

  if (existsSync(target)) {
    const name = ['codex', 'claude', 'omp', 'pi'].find((n) =>
      target.includes(`${path.sep}.${n}${path.sep}`)
    );
    picked = { name: name || 'claude', ref: target, file: target };
  } else {
    const items = await discover(names);
    picked = items.find(
      (x) =>
        (x.id && String(x.id).includes(target)) ||
        (x.ref && typeof x.ref === 'string' && path.basename(x.ref).includes(target))
    );
    if (!picked) throw new Error('找不到匹配的会话：' + target);
  }

  const cfg = SOURCES[picked.name];
  if (!cfg) throw new Error('未知来源：' + picked.name);

  const r = await cfg.parser.parse(picked.ref, { full: opts.full });
  const messages = normalizeMessages(r.messages);
  if (!messages.length) throw new Error('这个会话里没有可导出的对话');

  const md = buildDoc({
    title: r.title,
    url: r.source,
    channel: 'local/' + picked.name,
    messages,
    note: r.note,
  });

  if (opts.stdout) return console.log(md);
  await mkdir(opts.out, { recursive: true });
  const out = path.resolve(opts.out, safeName(r.title) + '.md');
  await writeFile(out, md, 'utf8');
  console.log(`OK ${picked.name} ${messages.length} 条 -> ${out}`);
}

function cmdSources() {
  for (const [name, cfg] of Object.entries(SOURCES)) {
    let where = cfg.root || '';
    let state = '';
    if (cfg.kind === 'sqlite') {
      where = (cfg.parser.dbPath && cfg.parser.dbPath()) || '(未找到数据库)';
      state = where.startsWith('(') ? '未安装' : '可用';
    } else {
      state = existsSync(cfg.root) ? '有目录' : '无目录';
    }
    console.log(`${name.padEnd(7)} ${cfg.label.padEnd(12)} ${state.padEnd(6)} ${where}`);
  }
}

const { cmd, positional, opts, names } = parseArgs(process.argv.slice(2));

try {
  if (cmd === 'list') await cmdList(opts, names);
  else if (cmd === 'search') await cmdSearch(positional[0], opts, names);
  else if (cmd === 'export') await cmdExport(positional[0], opts, names);
  else if (cmd === 'sources') cmdSources();
  else {
    console.error(
      '用法：\n' +
        '  node sessions.mjs sources\n' +
        '  node sessions.mjs list [--source <名字>|all] [--limit 20] [--json]\n' +
        '  node sessions.mjs search <关键词> [--source ...] [--limit 20]\n' +
        '  node sessions.mjs export <id 或路径> [--out DIR] [--stdout] [--full]'
    );
    process.exit(2);
  }
} catch (e) {
  console.error('FAIL :: ' + String(e.message || e));
  process.exit(1);
}
