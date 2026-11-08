// 压缩 rollout 的透明读取。
//
// Codex 会把归档会话压成 `<rollout>.jsonl.zst`（~/.codex/archived_sessions），
// 部分未归档会话也会被就地压缩。压缩过的文件 grep 不到、`readFile` 读出乱码，
// 所以所有按文件读会话的地方都要走这里。
//
// Node 22 的 zlib 已经带 zstd（实验性），没有就回退系统 `zstd` CLI。两样都没有
// 时抛错由调用方决定是跳过还是中断，不要静默返回空串。
import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { createZstdDecompress } from 'node:zlib';

export const isCompressed = (file) => /\.zst$/i.test(file);

function viaZlib(file) {
  if (typeof createZstdDecompress !== 'function') throw new Error('node:zlib 缺 zstd 支持');
  return createReadStream(file).pipe(createZstdDecompress());
}

function viaCli(file) {
  const child = spawn('zstd', ['-dc', file], { stdio: ['ignore', 'pipe', 'ignore'] });
  return child.stdout;
}

async function collect(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks);
}

// 整体读成字符串。只用于小文件；大文件（几十 MB 压缩、解压后可能上 GB）
// 用 lines() 流式走，避免撞上 V8 的字符串长度上限。
export async function readText(file) {
  if (!isCompressed(file)) return readFile(file, 'utf8');
  try {
    return (await collect(viaZlib(file))).toString('utf8');
  } catch {
    return (await collect(viaCli(file))).toString('utf8');
  }
}

async function* readLines(stream) {
  const rl = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) yield line;
  } finally {
    rl.close();
    if (typeof stream.destroy === 'function') stream.destroy();
  }
}

// 逐行异步迭代，普通文件与 .zst 一致。
export async function* lines(file) {
  if (!isCompressed(file)) {
    yield* readLines(createReadStream(file));
    return;
  }
  let started = false;
  try {
    for await (const line of readLines(viaZlib(file))) {
      started = true;
      yield line;
    }
    return;
  } catch (e) {
    // 中途出错不能回退，否则前面的行会重复
    if (started) throw e;
  }
  yield* readLines(viaCli(file));
}
