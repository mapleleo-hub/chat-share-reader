#!/usr/bin/env node
// 登录态批量导出：在已登录的浏览器页面里发请求，把账号下的全部会话拉成 markdown。
//
// 和 read.mjs 的分工：那个抓别人给的公开分享链接，一次一条；这个抓你自己账号里的
// 全部历史，一次几百上千条。两者的接口不是同一个：分享走免认证的 /share/<id>，
// 这里走登录后才放行的列表与详情接口。
//
// 依赖本机 opencli（Chrome 扩展 + daemon），它让你复用浏览器已有的登录态，
// 不需要导出 cookie，也不需要解密 Chrome 的 cookie 库。
//
// 用法：
//   node scripts/bulk.mjs sites
//   node scripts/bulk.mjs list --site deepseek
//   node scripts/bulk.mjs export --site deepseek --out ../../25-chatArchive/archive --limit 20
//   node scripts/bulk.mjs export --site deepseek --out DIR --since 2026-09-01
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { available, createSession } from './lib/backend/opencli.mjs';
import { buildDoc, safeName } from './lib/md.mjs';

const SESSION = 'csr-bulk';
// 页面里的 fetch 和 XHR 都可能被站点自己的脚本改写：Qwen 的阿里埋点包了 fetch，WAF 又
// 挂了 XHR；豆包同类。同源空白 iframe 里的 fetch 是没被碰过的原生实现，优先用它，
// 拿不到再退回顶层 XHR，最后才用被改写过的 fetch。
const PRELUDE = `
window.__req = async function (url, opts) {
  const abs = new URL(url, location.href).href;
  const parse = (t) => { try { return JSON.parse(t); } catch (e) { return null; } };
  try {
    const f = document.createElement("iframe");
    f.style.display = "none";
    document.body.appendChild(f);
    const w = f.contentWindow;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), (opts && opts.timeout) || 25000);
    const r = await w.fetch(abs, { credentials: "include", signal: ctl.signal });
    const t = await r.text();
    clearTimeout(timer);
    f.remove();
    return { status: r.status, text: t, json: parse(t), via: "iframe" };
  } catch (e) {}
  return await new Promise(function (res) {
    try {
      var x = new XMLHttpRequest();
      x.open((opts && opts.method) || "GET", url, true);
      x.withCredentials = true;
      x.timeout = (opts && opts.timeout) || 25000;
      x.onload = function () { res({ status: x.status, text: x.responseText, json: parse(x.responseText), via: "xhr" }); };
      x.onerror = function () { res({ status: 0, error: "network", via: "xhr" }); };
      x.ontimeout = function () { res({ status: 0, error: "timeout", via: "xhr" }); };
      x.send((opts && opts.body) || null);
    } catch (e) { res({ status: 0, error: String(e), via: "xhr" }); }
  });
};
window.__apis = function () {
  return performance.getEntriesByType("resource")
    .map(function (e) { return e.name; })
    .filter(function (n) { return n.indexOf("/api/") >= 0 || n.indexOf("/samantha/") >= 0 || n.indexOf("/alice/") >= 0; });
};
`;


// 每个站点的抓取脚本都在页面上下文执行，靠 window.__arg 传参、window.__list /
// window.__batch / window.__err 回传。脚本里可以随便用引号和花括号，因为注入前
// 会整段 base64，不经过 shell。
const SITES = {
  deepseek: {
    label: 'DeepSeek',
    entry: 'https://chat.deepseek.com/',
    loginProbe: 'window.__probe = document.cookie.includes("ds_session_id") ? "in" : "out"',
    listScript: `(async () => { const req = window.__req;
      const out = [];
      let ts = null;
      for (let page = 0; page < 500; page++) {
        const url = ts
          ? "/api/v0/chat_session/fetch_page?count=100&lte_time=" + ts
          : "/api/v0/chat_session/fetch_page?count=100";
        const r = await req(url);
        const j = r.json || {};
        if (j.code !== 0) { window.__err = JSON.stringify(j) + " status=" + r.status; return; }
        const biz = (j.data && j.data.biz_data) || {};
        const arr = biz.chat_sessions || [];
        for (const s of arr) out.push({ id: s.id, title: s.title || "", updatedAt: s.updated_at || 0 });
        if (!biz.has_more || !arr.length) break;
        ts = arr[arr.length - 1].updated_at;
        await new Promise((r) => setTimeout(r, 300));
      }
      window.__list = JSON.stringify(out);
    })()`,
    detailScript: `(async () => { const req = window.__req;
      const ids = window.__arg || [];
      const out = [];
      for (const it of ids) {
        try {
          const r = await req("/api/v0/chat/history_messages?chat_session_id=" + it.id);
          const j = r.json || {};
          const biz = (j.data && j.data.biz_data) || {};
          const msgs = (biz.chat_messages || []).map((m) => ({
            role: m.role === "USER" ? "user" : "assistant",
            time: m.inserted_at ? new Date(m.inserted_at * 1000).toISOString() : "",
            body: (m.content || "").trim()
          })).filter((m) => m.body);
          out.push({ id: it.id, title: it.title || "", updatedAt: it.updatedAt || 0, messages: msgs });
        } catch (e) {
          out.push({ id: it.id, error: String(e) });
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      window.__batch = JSON.stringify(out);
    })()`,
  },

  qwen: {
    label: 'Qwen',
    entry: 'https://chat.qwen.ai/',
    listScript: `(async () => { const req = window.__req;
      const out = [];
      let page = 1;
      for (let i = 0; i < 500; i++) {
        const r = await req("/api/v1/chats/?page=" + page);
        const j = r.json || {};
        if (!r.status || r.status >= 400) { window.__err = (r.error || ("status " + r.status)) + " " + (r.text || "").slice(0, 200); return; }
        const arr = (j.data && j.data.chats) || j.chats || (Array.isArray(j.data) ? j.data : []);
        if (!arr.length) break;
        for (const s of arr) out.push({ id: s.id, title: s.title || "", updatedAt: s.updated_at || s.timestamp || 0 });
        if (arr.length < 20) break;
        page += 1;
        await new Promise((r) => setTimeout(r, 300));
      }
      window.__list = JSON.stringify(out);
    })()`,
    detailScript: `(async () => { const req = window.__req;
      const ids = window.__arg || [];
      const out = [];
      for (const it of ids) {
        try {
          const r = await req("/api/v1/chats/" + it.id);
          const j = r.json || {};
          const msgs = (j.messages || (j.data && j.data.messages) || []).map((m) => ({
            role: m.role === "user" ? "user" : "assistant",
            time: m.created_at || m.timestamp || "",
            body: (m.content || "").trim()
          })).filter((m) => m.body);
          out.push({ id: it.id, title: it.title || "", updatedAt: it.updatedAt || 0, messages: msgs });
        } catch (e) {
          out.push({ id: it.id, error: String(e) });
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      window.__batch = JSON.stringify(out);
    })()`,
  },

  kimi: {
    label: 'Kimi',
    entry: 'https://www.kimi.com/',
    listScript: `(async () => { const req = window.__req;
      const out = [];
      let cursor = "";
      for (let i = 0; i < 500; i++) {
        const url = "/api/chat/list?page_size=50" + (cursor ? "&cursor=" + encodeURIComponent(cursor) : "");
        const r = await req(url);
        const j = r.json || {};
        if (!r.status || r.status >= 400) { window.__err = (r.error || ("status " + r.status)) + " " + (r.text || "").slice(0, 200); return; }
        const arr = (j.data && (j.data.chats || j.data.list)) || j.chats || [];
        if (!arr.length) break;
        for (const s of arr) out.push({ id: s.id, title: s.name || s.title || "", updatedAt: s.update_time || s.updated_at || 0 });
        cursor = (j.data && j.data.next_cursor) || "";
        if (!cursor) break;
        await new Promise((r) => setTimeout(r, 300));
      }
      window.__list = JSON.stringify(out);
    })()`,
    detailScript: `(async () => { const req = window.__req;
      const ids = window.__arg || [];
      const out = [];
      for (const it of ids) {
        try {
          const r = await req("/api/chat/" + it.id + "/detail");
          const j = r.json || {};
          const src = (j.data && (j.data.messages || j.data.chat && j.data.chat.messages)) || [];
          const msgs = src.map((m) => ({
            role: (m.role === "user" || m.sender === "user") ? "user" : "assistant",
            time: m.create_time || m.created_at || "",
            body: (typeof m.content === "string" ? m.content : (m.content && m.content.text) || "").trim()
          })).filter((m) => m.body);
          out.push({ id: it.id, title: it.title || "", updatedAt: it.updatedAt || 0, messages: msgs });
        } catch (e) {
          out.push({ id: it.id, error: String(e) });
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      window.__batch = JSON.stringify(out);
    })()`,
  },

  chatgpt: {
    label: 'ChatGPT',
    entry: 'https://chatgpt.com/',
    listScript: `(async () => { const req = window.__req;
      const out = [];
      let offset = 0;
      for (let i = 0; i < 500; i++) {
        const r = await req("/backend-api/conversations?offset=" + offset + "&limit=100&order=updated");
        if (r.status === 401 || r.status === 403) { window.__err = "未登录或登录已失效：" + r.status; return; }
        const j = r.json || {};
        const arr = j.items || [];
        for (const s of arr) out.push({ id: s.id, title: s.title || "", updatedAt: s.update_time || s.create_time || 0 });
        if (!arr.length || arr.length < 100) break;
        offset += arr.length;
        await new Promise((r) => setTimeout(r, 300));
      }
      window.__list = JSON.stringify(out);
    })()`,
    detailScript: `(async () => { const req = window.__req;
      const ids = window.__arg || [];
      const out = [];
      for (const it of ids) {
        try {
          const r = await req("/backend-api/conversation/" + it.id);
          const j = r.json || {};
          const mapping = j.mapping || {};
          let cur = j.current_node;
          const chain = [];
          const seen = new Set();
          while (cur && mapping[cur] && !seen.has(cur)) {
            seen.add(cur);
            chain.push(mapping[cur]);
            cur = mapping[cur].parent;
          }
          chain.reverse();
          const msgs = [];
          for (const node of chain) {
            const msg = node && node.message;
            if (!msg) continue;
            const role = msg.author && msg.author.role;
            if (role !== "user" && role !== "assistant") continue;
            if (msg.metadata && msg.metadata.is_visually_hidden_from_conversation) continue;
            const parts = (msg.content && msg.content.parts) || [];
            const body = parts.filter((p) => typeof p === "string").join("\\n\\n").trim();
            if (!body) continue;
            msgs.push({ role, time: msg.create_time || "", body });
          }
          out.push({ id: it.id, title: j.title || it.title || "", updatedAt: it.updatedAt || 0, messages: msgs });
        } catch (e) {
          out.push({ id: it.id, error: String(e) });
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      window.__batch = JSON.stringify(out);
    })()`,
  },

  claude: {
    label: 'Claude',
    entry: 'https://claude.ai/',
    listScript: `(async () => { const req = window.__req;
      const orgsResp = await req("/api/organizations");
      const orgs = orgsResp.json || [];
      const org = Array.isArray(orgs) && orgs[0] && (orgs[0].uuid || orgs[0].id);
      if (!org) { window.__err = "拿不到组织 id，可能未登录"; return; }
      window.__org = org;
      const out = [];
      let offset = 0;
      for (let i = 0; i < 500; i++) {
        const r = await req("/api/organizations/" + org + "/chat_conversations?limit=100&offset=" + offset + "&starred=false");
        if (!r.status || r.status >= 400) { window.__err = "列表接口 " + r.status + " " + (r.text || "").slice(0, 200); return; }
        const arr = r.json;
        if (!Array.isArray(arr) || !arr.length) break;
        for (const s of arr) out.push({ id: s.uuid, title: s.name || "", updatedAt: s.updated_at || "" });
        if (arr.length < 100) break;
        offset += arr.length;
        await new Promise((r) => setTimeout(r, 300));
      }
      window.__list = JSON.stringify(out);
    })()`,
    detailScript: `(async () => { const req = window.__req;
      const ids = window.__arg || [];
      const org = window.__org;
      const out = [];
      for (const it of ids) {
        try {
          const r = await req("/api/organizations/" + org + "/chat_conversations/" + it.id + "?tree=True&rendering_mode=messages&render_all_tools=true");
          const j = r.json || {};
          const msgs = (j.chat_messages || []).map((m) => ({
            role: m.sender === "human" ? "user" : "assistant",
            time: m.created_at || "",
            body: (m.text || "").trim()
          })).filter((m) => m.body);
          out.push({ id: it.id, title: j.name || it.title || "", updatedAt: it.updatedAt || 0, messages: msgs });
        } catch (e) {
          out.push({ id: it.id, error: String(e) });
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      window.__batch = JSON.stringify(out);
    })()`,
  },
};

function cleanJson(raw) {
  const s = String(raw || '').trim();
  if (!s || s === 'undefined' || s === 'null') return null;
  const starts = [s.indexOf('['), s.indexOf('{')].filter((i) => i >= 0);
  if (!starts.length) return null;
  const a = Math.min(...starts);
  const lastArr = s.lastIndexOf(']');
  const lastObj = s.lastIndexOf('}');
  const b = Math.max(lastArr, lastObj);
  if (b < a) return null;
  try {
    return JSON.parse(s.slice(a, b + 1));
  } catch {
    return null;
  }
}

async function waitVar(sess, name, { tries = 180, delay = 1000 } = {}) {
  for (let i = 0; i < tries; i++) {
    const v = cleanJson(await sess.eval(`window.${name} || ""`));
    if (v) return v;
    await sleep(delay);
  }
  return null;
}

function isoTime(t) {
  if (!t) return '';
  const n = typeof t === 'number' ? (t > 1e12 ? t : t * 1000) : Date.parse(t);
  if (!Number.isFinite(n)) return '';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function slug(title) {
  return safeName(String(title || 'untitled')).slice(0, 40).replace(/^\.+/, '') || 'untitled';
}

async function openSite(sess, site) {
  await sess.open(site.entry);
  await sleep(3000);
  await sess.eval(PRELUDE);
  const here = await sess.eval('location.href');
  return String(here || '').trim();
}

async function fetchList(sess, site) {
  await sess.eval('window.__err = ""; window.__list = ""');
  await sess.eval(site.listScript);
  const err = cleanJson(await sess.eval('window.__err || ""'));
  if (err) throw new Error(`列表接口报错：${typeof err === 'string' ? err : JSON.stringify(err).slice(0, 300)}`);
  const list = await waitVar(sess, '__list');
  if (!list) throw new Error('列表超时未返回，可能是登录态失效或接口改版');
  return list;
}

async function fetchBatch(sess, site, items) {
  await sess.eval(`window.__batch = ""; window.__arg = ${JSON.stringify(items)}`);
  await sess.eval(site.detailScript);
  const batch = await waitVar(sess, '__batch', { tries: 120, delay: 1000 });
  if (!batch) return [];
  return batch;
}

async function cmdExport(opts) {
  const site = SITES[opts.site];
  if (!site) throw new Error(`未知站点：${opts.site}`);
  if (!available()) throw new Error('没有可用的 opencli，先装 opencli 并确保 Chrome 扩展已连接');

  const sess = await createSession({ name: SESSION });
  const outDir = path.resolve(opts.out);

  const where = await openSite(sess, site);
  if (/sign_in|login|signin/i.test(where)) {
    throw new Error(`还没登录 ${site.label}，当前停在 ${where}。先在浏览器里登录一次再跑。`);
  }

  const list = await fetchList(sess, site);
  console.log(`${site.label} 账号下共 ${list.length} 个会话`);

  let todo = list;
  if (opts.since) todo = todo.filter((x) => isoTime(x.updatedAt) >= opts.since);
  if (opts.limit) todo = todo.slice(0, opts.limit);
  todo.sort((a, b) => String(isoTime(b.updatedAt)).localeCompare(String(isoTime(a.updatedAt))));
  console.log(`本次导出 ${todo.length} 个${opts.since ? `（${opts.since} 之后）` : ''}`);

  const records = [];
  const failed = [];
  const size = Math.max(1, opts.batch || 15);
  for (let i = 0; i < todo.length; i += size) {
    const chunk = todo.slice(i, i + size);
    const got = await fetchBatch(sess, site, chunk);
    for (const conv of got) {
      if (conv.error || !conv.messages || !conv.messages.length) {
        failed.push({ id: conv.id, error: conv.error || '无消息' });
        continue;
      }
      const day = isoTime(conv.updatedAt) || '0000-00-00';
      const dir = path.join(outDir, opts.site, day.slice(0, 7));
      await mkdir(dir, { recursive: true });
      const file = path.join(dir, `${day}_${opts.site}_${String(conv.id).slice(0, 12)}_${slug(conv.title)}.md`);
      const md = buildDoc({
        title: conv.title || '(无标题)',
        url: site.entry,
        channel: `bulk/${opts.site}`,
        messages: conv.messages.map((m) => ({ role: m.role, time: m.time, body: m.body })),
      });
      await writeFile(file, md, 'utf8');
      records.push({
        date: day,
        source: opts.site,
        id: conv.id,
        title: conv.title || '',
        messages: conv.messages.length,
        chars: conv.messages.reduce((n, m) => n + m.body.length, 0),
        file,
      });
    }
    const done = Math.min(i + size, todo.length);
    console.log(`[${done}/${todo.length}] 本批 ${got.length} 条`);
    await sleep(opts.delay || 400);
  }

  const indexFile = path.join(outDir, `bulk-${opts.site}.jsonl`);
  await writeFile(indexFile, records.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  if (failed.length) {
    await writeFile(path.join(outDir, `bulk-${opts.site}-failed.json`), JSON.stringify(failed, null, 1), 'utf8');
  }
  console.log(`\n完成：成功 ${records.length}，失败 ${failed.length}`);
  console.log(`正文 ${records.reduce((n, r) => n + r.chars, 0).toLocaleString()} 字符`);
  console.log(`索引 ${indexFile}`);
}


// 登录后第一条该跑的命令：把页面自己发过的接口列出来，逐个打一次，打印状态和响应开头。
// 接口路径、字段名都能从这里读到，不用猜。
async function cmdProbe(opts) {
  const site = SITES[opts.site];
  if (!site) throw new Error(`未知站点：${opts.site}`);
  const sess = await createSession({ name: SESSION });
  await openSite(sess, site);
  const apis = cleanJson(await sess.eval('JSON.stringify(window.__apis())')) || [];
  const uniq = [...new Set(apis)].filter((u) => !/configs|models|tts|users\/status|refresh/.test(u));
  console.log(`${site.label} 页面发起过的业务接口 ${uniq.length} 个`);
  for (const u of uniq.slice(0, opts.limit || 8)) {
    await sess.eval(`window.__p = ""`);
    await sess.eval(`window.__req(${JSON.stringify(u)}, { timeout: 12000 }).then(function (r) { window.__p = JSON.stringify({ status: r.status, via: r.via, head: String(r.text || "").slice(0, 400) }); })`);
    const out = await waitVar(sess, '__p', { tries: 15, delay: 1000 });
    console.log(`\n${u}`);
    console.log(out ? `  ${out.status} via ${out.via}  ${String(out.head).replace(/\s+/g, ' ').slice(0, 300)}` : '  无响应');
  }
}

async function cmdList(opts) {
  const site = SITES[opts.site];
  if (!site) throw new Error(`未知站点：${opts.site}`);
  const sess = await createSession({ name: SESSION });
  const where = await openSite(sess, site);
  if (/sign_in|login|signin/i.test(where)) {
    console.log(`未登录，当前停在 ${where}`);
    return;
  }
  const list = await fetchList(sess, site);
  console.log(`${site.label} 共 ${list.length} 个会话`);
  for (const x of list.slice(0, opts.limit || 20)) {
    console.log(`${isoTime(x.updatedAt) || '----'}  ${String(x.id).slice(0, 14)}  ${x.title || '(无标题)'}`);
  }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const opts = { site: 'deepseek', out: './bulk-out', limit: 0, since: '', batch: 15, delay: 400 };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--site') opts.site = rest[++i];
    else if (a === '--out') opts.out = rest[++i];
    else if (a === '--limit') opts.limit = Number(rest[++i]);
    else if (a === '--since') opts.since = rest[++i];
    else if (a === '--batch') opts.batch = Number(rest[++i]);
    else if (a === '--delay') opts.delay = Number(rest[++i]);
  }

  if (cmd === 'sites') {
    for (const [k, v] of Object.entries(SITES)) console.log(`${k.padEnd(10)} ${v.label}  ${v.entry}`);
    return;
  }
  if (cmd === 'probe') return cmdProbe(opts);
  if (cmd === 'list') return cmdList(opts);
  if (cmd === 'export') return cmdExport(opts);
  console.log(`用法：
  node scripts/bulk.mjs sites
  node scripts/bulk.mjs probe  --site deepseek      # 登录后先校准接口
  node scripts/bulk.mjs list   --site deepseek [--limit 20]
  node scripts/bulk.mjs export --site deepseek --out DIR [--since 2026-09-01] [--limit N] [--batch 15]`);
}

main().catch((e) => {
  console.error(String(e.message || e));
  process.exitCode = 1;
});
