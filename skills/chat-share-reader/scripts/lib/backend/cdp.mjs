// CDP 后端：拉起用户本机的 Chrome（真实二进制、真实指纹），用 DevTools 协议驱动。
// 这是普适方案：零 npm 依赖（Node 22 内置 WebSocket），跨平台，不需要装 opencli。
//
// 关键实测结论：Cloudflare 判定看的是浏览器 profile 的"信誉"，不是 UA。
// 全新 profile 第一次访问 grok.com / perplexity.ai 会停在挑战页，Claude 能直接过。
// 所以这里不假装自己是浏览器，而是遇到挑战时提示用户在弹出的窗口里手动过一次，
// cookie 存进持久 profile，之后就不用再管。
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { config, norm } from '../config.mjs';

const CHROME_CANDIDATES = [
  process.env.CHROME_BIN,
  norm(config().chromeBin),
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
].filter(Boolean);

const CHALLENGE_HINTS = [
  'Just a moment',
  '正在进行安全验证',
  '请稍候',
  'Verifying you are human',
  'Checking your browser',
  '安全服务防护',
];

export function findChrome() {
  for (const p of CHROME_CANDIDATES) if (existsSync(p)) return p;
  return '';
}

export function available() {
  return !!findChrome();
}

export function defaultProfile() {
  return (
    process.env.CSR_PROFILE ||
    norm(config().profile) ||
    path.join(os.homedir(), '.chat-share-reader', 'chrome-profile')
  );
}

export function defaultPort() {
  return Number(process.env.CSR_PORT || config().port || 9333);
}

async function waitForPort(port, tries = 60) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return await r.json();
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  throw new Error(`Chrome 调试端口 ${port} 没起来`);
}

async function launchChrome({ port, profile }) {
  const bin = findChrome();
  if (!bin) throw new Error('没找到 Chrome / Edge，可用 CHROME_BIN 指定路径');
  await mkdir(profile, { recursive: true });

  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-blink-features=AutomationControlled',
    '--window-size=1280,960',
    'about:blank',
  ];
  const proc = spawn(bin, args, { stdio: 'ignore' });
  proc.unref();
  return proc;
}

class Conn {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    ws.addEventListener('message', (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      const p = msg.id && this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message));
      else p.resolve(msg.result);
    });
  }

  static async open(wsUrl) {
    const ws = new WebSocket(wsUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', res, { once: true });
      ws.addEventListener('error', () => rej(new Error('CDP WebSocket 连不上')), { once: true });
    });
    return new Conn(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

export async function createSession({ port = defaultPort(), profile, name = 'csr' } = {}) {
  const prof = profile || defaultProfile();
  let version = null;
  try {
    version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
  } catch {
    version = null;
  }
  if (!version) {
    await launchChrome({ port, profile: prof });
    version = await waitForPort(port);
  }

  let tabId = null;
  let conn = null;
  let told = false;

  async function ensureTab(url) {
    if (conn) {
      conn.close();
      conn = null;
    }
    const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
      method: 'PUT',
    });
    if (!r.ok) throw new Error('开标签失败：HTTP ' + r.status);
    const tab = await r.json();
    tabId = tab.id;
    conn = await Conn.open(tab.webSocketDebuggerUrl);
    await conn.send('Page.enable').catch(() => {});
    await conn.send('Runtime.enable').catch(() => {});
    return tab;
  }

  return {
    backend: 'cdp',
    name,

    async open(url) {
      await ensureTab(url);
    },

    async eval(code) {
      const r = await conn.send('Runtime.evaluate', {
        expression: code,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(
          '页面脚本报错：' +
            (r.exceptionDetails.exception?.description || r.exceptionDetails.text || '')
        );
      }
      return typeof r.result.value === 'string' ? r.result.value : JSON.stringify(r.result.value);
    },

    async waitReady({ minText = 200, tries = 20, delay = 3000, probe } = {}) {
      for (let i = 0; i < tries; i++) {
        const code =
          probe || 'JSON.stringify({len: document.body.innerText.length, url: location.href})';
        try {
          const out = await this.eval(code);
          const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
          if (probe ? j.ok : j.len >= minText) return j;
          if (!probe) {
            const text = await this.eval('document.body.innerText.slice(0,200)');
            if (!told && CHALLENGE_HINTS.some((h) => text.includes(h))) {
              told = true;
              console.error(
                '[提示] 页面停在安全验证。请在弹出的 Chrome 窗口里手动完成验证，脚本会继续等（最多 1 分钟）。'
              );
            }
          }
        } catch {
          /* 页面还在导航 */
        }
        await sleep(delay);
      }
      throw new Error('页面在超时内没有渲染出内容（可能是安全验证没通过）');
    },

    // 只关标签，不关浏览器：关掉 Chrome 会丢掉用户刚建立的 profile 信誉
    async close() {
      if (conn) {
        conn.close();
        conn = null;
      }
      if (tabId) {
        await fetch(`http://127.0.0.1:${port}/json/close/${tabId}`).catch(() => {});
        tabId = null;
      }
    },
  };
}
