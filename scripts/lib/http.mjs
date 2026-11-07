// curl 封装。用子进程而不是 Node fetch：重定向、压缩、系统代理都由 curl 处理。
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';

export async function httpGet(url, { headers = [], timeout = 45 } = {}) {
  const args = ['-sSL', '--compressed', '-m', String(timeout), '-A', UA];
  for (const h of headers) args.push('-H', h);
  args.push(url);
  const { stdout } = await exec('curl', args, { maxBuffer: 512 * 1024 * 1024 });
  return stdout;
}

export async function httpGetJson(url, opts) {
  const text = await httpGet(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    const hint = /Just a moment|cf-challenge/.test(text)
      ? '被 Cloudflare 挑战拦截，这个站点需要浏览器通道'
      : '返回不是 JSON';
    throw new Error(`${hint}（${url}）`);
  }
}

// 从 HTML 里捞一段内联 JSON 对象（按括号配平截取）
export function sliceJsonObject(html, startIndex) {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = startIndex; i < html.length; i++) {
    const ch = html[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return html.slice(startIndex, i + 1);
    }
  }
  return null;
}
