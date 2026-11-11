// opencli 后端：复用本机已装的 opencli（Chrome 扩展 + 本地 daemon）。
// 优点是不用管 Chrome 启动与登录态；缺点是只有装了 opencli 的机器有，所以它是可选后端。
//
// 三条硬约束（实测，改之前先看 references/sites.md）：
// 1. opencli 是 git-bash 包装脚本，必须经 bash 调用且 shell:false，否则 URL 里的 & 被当命令分隔
// 2. eval 会吃掉单引号，所以页面脚本一律 base64 注入
// 3. eval 单次表达式约 5k 字符上限，且含 {} 的表达式直接挂，所以 base64 分片
import { execFile, execFileSync } from 'node:child_process';
import { config, norm } from '../config.mjs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';

const exec = promisify(execFile);
const CHUNK = 3000;
const VAR = 'window.__csr';

export function findOpencli() {
  const candidates = [
    process.env.OPENCLI_BIN,
    norm(config().opencliBin),
    norm(path.join(os.homedir(), 'bin', 'opencli')),
    '/usr/local/bin/opencli',
    '/opt/homebrew/bin/opencli',
  ].filter(Boolean);
  for (const p of candidates) if (existsSync(p)) return p;

  // PATH 里找
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['opencli'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const first = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0];
    if (first && existsSync(first)) return first;
  } catch {
    /* 没装 */
  }
  return '';
}

export function available() {
  return !!findOpencli();
}

export async function createSession({ name = 'csr', bin } = {}) {
  const exe = bin || findOpencli();
  if (!exe) throw new Error('没有可用的 opencli');

  async function raw(...args) {
    const { stdout } = await exec('bash', [exe, 'browser', name, ...args], {
      maxBuffer: 512 * 1024 * 1024,
      shell: false,
    });
    return stdout;
  }

  async function cmd(...args) {
    let last;
    for (let i = 0; i < 4; i++) {
      try {
        return await raw(...args);
      } catch (e) {
        last = e;
        await sleep(2500);
      }
    }
    throw new Error(
      `opencli 调用失败：${args.join(' ')} :: ${String((last && last.stderr) || last).slice(0, 300)}`
    );
  }

  return {
    backend: 'opencli',
    name,

    async open(url, opts) {
      // 有些站（Gemini）在后台标签会被浏览器节流，Angular 不渲染，必须前台窗口打开
      const win = (opts && opts.window) || 'background';
      await cmd('open', url, '--window', win);
    },

    async eval(code) {
      const b64 = Buffer.from(code, 'utf8').toString('base64');
      await cmd('eval', `${VAR} = ""`);
      for (let i = 0; i < b64.length; i += CHUNK) {
        await cmd('eval', `${VAR} += "${b64.slice(i, i + CHUNK)}"`);
      }
      return cmd(
        'eval',
        `eval(new TextDecoder().decode(Uint8Array.from(atob(${VAR}),c=>c.charCodeAt(0))))`
      );
    },

    async waitReady({ minText = 200, tries = 10, delay = 3000, probe } = {}) {
      for (let i = 0; i < tries; i++) {
        const code =
          probe || 'JSON.stringify({len: document.body.innerText.length, url: location.href})';
        let out;
        try {
          out = await raw('eval', code);
        } catch {
          await sleep(delay);
          continue;
        }
        try {
          const j = JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
          if (probe ? j.ok : j.len >= minText) return j;
        } catch {
          /* 还没渲染 */
        }
        await sleep(delay);
      }
      throw new Error('页面在超时内没有渲染出内容');
    },

    async close() {
      try {
        await raw('close');
      } catch {
        /* 关不掉就算了 */
      }
    },
  };
}
