#!/usr/bin/env node
// 本地会话入口：列出、搜索、导出本机 AI 编码 agent 的会话记录。
//
// 用法：
//   node sessions.mjs list [--source claude|codex|all] [--limit 20] [--json]
//   node sessions.mjs search <关键词> [--source ...] [--limit 20]
//   node sessions.mjs export <会话 id 或文件路径> [--out DIR] [--stdout] [--full]
//
// 和 read.mjs 的区别：那个处理别人发来的分享链接，这个读你自己机器上的会话文件。
import { readdir, stat, readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as claudeLocal from './lib/local/claude.mjs';
import * as codexLocal from './lib/local/codex.mjs';
import { buildDoc, safeName, normalizeMessages } from './lib/md.mjs';

const PARSERS = { claude: claudeLocal, codex: codexLocal };

const ROOTS = {
  claude: path.join(os.homedir(), '.claude', 'projects'),
  codex: path.join(os.homedir(), '.codex', 'sessions'),
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

async function discover(sources) {
  const files = [];
  for (const s of sources) {
    if (!existsSync(ROOTS[s])) continue;
    for (const f of await walk(ROOTS[s])) files.push({ source: s, file: f });
  }
  const withStat = await Promise.all(
    files.map(async (x) => {
      try {
        const st = await stat(x.file);
        return { ...x, mtime: st.mtimeMs, size: st.size };
      } catch {
        return null;
      }
    })
  );
  return withStat.filter(Boolean).sort((a, b) => b.mtime - a.mtime);
}

// 只读文件前部找标题，避免为了列表把所有会话全解析一遍
async function peek(file, source) {
  const raw = await readFile(file, 'utf8');
  const lines = raw.split('\n').slice(0, 400);
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    let j;
    try {
      j = JSON.parse(s);
    } catch {
      continue;
    }
    if (source === 'claude') {
      if (j.type !== 'user' || j.isSidechain) continue;
      const c = j.message && j.message.content;
      const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x && x.text) || '').join(' ') : '';
      if (text.trim()) return tidy(text);
    } else {
      if (j.type !== 'event_msg' || !j.payload || j.payload.type !== 'item_completed') continue;
      const it = j.payload.item || {};
      if (it.type !== 'UserMessage') continue;
      const text = (it.content || []).map((c) => (c && (c.text || c.Text)) || '').join(' ');
      if (text.trim()) return tidy(text);
    }
  }
  return '';
}

function tidy(t) {
  return t
    .replace(/[#*`>\n]/g, ' ')
    .replace(/[，。、？！；："'（）《》…—\s]+/g, ' ')
    .trim()
    .slice(0, 40)
    .trim();
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
  const sources = opts.source === 'all' ? ['claude', 'codex'] : [opts.source];
  return { cmd, positional, opts, sources };
}

async function cmdList(opts, sources) {
  const items = (await discover(sources)).slice(0, opts.limit);
  const rows = [];
  for (const it of items) {
    const title = await peek(it.file, it.source).catch(() => '');
    rows.push({
      source: it.source,
      time: new Date(it.mtime).toLocaleString('zh-CN', { hour12: false }),
      size: Math.round(it.size / 1024) + 'K',
      title: title || '(无标题)',
      file: it.file,
    });
  }
  if (opts.json) return console.log(JSON.stringify(rows, null, 2));
  for (const r of rows) {
    console.log(`${r.time}  ${r.source.padEnd(6)} ${r.size.padStart(6)}  ${r.title}`);
    console.log(`  ${r.file}`);
  }
}

async function cmdSearch(keyword, opts, sources) {
  if (!keyword) throw new Error('要给一个关键词');
  const items = await discover(sources);
  const hits = [];
  for (const it of items) {
    const raw = await readFile(it.file, 'utf8').catch(() => '');
    const idx = raw.indexOf(keyword);
    if (idx < 0) continue;
    const ctx = raw
      .slice(Math.max(0, idx - 60), idx + keyword.length + 60)
      .replace(/\\n/g, ' ')
      .replace(/\s+/g, ' ');
    hits.push({
      source: it.source,
      time: new Date(it.mtime).toLocaleString('zh-CN', { hour12: false }),
      file: it.file,
      ctx,
    });
    if (hits.length >= opts.limit) break;
  }
  if (opts.json) return console.log(JSON.stringify(hits, null, 2));
  if (!hits.length) return console.log('没有命中');
  for (const h of hits) {
    console.log(`${h.time}  ${h.source.padEnd(6)} ${h.ctx}`);
    console.log(`  ${h.file}`);
  }
}

async function cmdExport(target, opts, sources) {
  if (!target) throw new Error('要给会话 id 或文件路径');

  let file = target;
  let source = null;
  if (!existsSync(file)) {
    const items = await discover(sources);
    const hit = items.find(
      (x) => path.basename(x.file).includes(target) || x.file.includes(target)
    );
    if (!hit) throw new Error('找不到匹配的会话：' + target);
    file = hit.file;
    source = hit.source;
  }
  if (!source) {
    source = file.includes(`${path.sep}.codex${path.sep}`) ? 'codex' : 'claude';
  }

  const parser = PARSERS[source];
  const r = await parser.parse(file, { full: opts.full });
  const messages = normalizeMessages(r.messages);
  if (!messages.length) throw new Error('这个会话里没有可导出的对话');

  // 本地会话没有「数据接口」，来源直接给文件路径
  const md = buildDoc({
    title: r.title,
    url: file,
    channel: 'local/' + source,
    messages,
    note: r.note,
  });

  if (opts.stdout) return console.log(md);
  await mkdir(opts.out, { recursive: true });
  const out = path.resolve(opts.out, safeName(r.title) + '.md');
  await writeFile(out, md, 'utf8');
  console.log(`OK ${source} ${messages.length} 条 -> ${out}`);
}

const { cmd, positional, opts, sources } = parseArgs(process.argv.slice(2));

try {
  if (cmd === 'list') await cmdList(opts, sources);
  else if (cmd === 'search') await cmdSearch(positional[0], opts, sources);
  else if (cmd === 'export') await cmdExport(positional[0], opts, sources);
  else {
    console.error(
      '用法：\n' +
        '  node sessions.mjs list [--source claude|codex|all] [--limit 20] [--json]\n' +
        '  node sessions.mjs search <关键词> [--source ...] [--limit 20]\n' +
        '  node sessions.mjs export <id 或路径> [--out DIR] [--stdout] [--full]'
    );
    process.exit(2);
  }
} catch (e) {
  console.error('FAIL :: ' + String(e.message || e));
  process.exit(1);
}
