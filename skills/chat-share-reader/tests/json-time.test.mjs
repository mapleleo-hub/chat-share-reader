// list / search 的结构化输出里，时间必须是程序能用的。
//
// 背景：这两个命令的 --json 原来只给 `time`，值是 fmtTime 的结果（`2026/11/11 23:00`），
// search 的消息级甚至是 `23:19` 这种没有日期的串。既不能排序也不能算差值，还要
// 猜时区。改成 ts（毫秒）+ time（展示）两个字段，跟 dump / export 一个口径。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const SID = '01a1af92-bbbb-4ccc-8ddd-000000000001';

const meta = JSON.stringify({
  timestamp: '2026-11-13T02:00:00.000Z',
  type: 'session_meta',
  payload: { session_id: SID, id: SID, cwd: '/w/demo', thread_source: 'user' },
});
const msg = (kind, text, at) =>
  JSON.stringify({
    timestamp: at,
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: kind, content: [{ text }] } },
  });

// 文件名里的时间就是「对话时间」，用固定的 2026-11-13T10:00 本地时间，
// 断言里按本地构造出期望值，不依赖跑测试的机器在哪个时区。
const NAME_AT = new Date(2026, 10, 13, 10, 0, 0);

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'csr-json-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '13');
  await mkdir(dir, { recursive: true });
  await writeFile(
    path.join(dir, `rollout-2026-11-13T10-00-00-${SID}.jsonl`),
    [
      meta,
      msg('UserMessage', '问一下海参的处理方式', '2026-11-13T02:00:01.000Z'),
      msg('AgentMessage', '先泡发再炖', '2026-11-13T02:00:05.000Z'),
    ].join('\n') + '\n',
    'utf8'
  );
  return home;
}

async function cli(home, args) {
  const env = { ...process.env, CSR_HOME: home, CSR_LANG: 'zh', NO_PROXY: '127.0.0.1,localhost' };
  const { stdout } = await run(process.execPath, [path.join(root, 'scripts', 'sessions.mjs'), ...args], {
    cwd: root,
    env,
    timeout: 60000,
    maxBuffer: 32 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

test('list --json 给毫秒时间，同时保留展示写法', async () => {
  const home = await fixture();
  try {
    const rows = await cli(home, ['list', '--source', 'codex', '--json']);
    assert.equal(rows.length, 1);
    assert.equal(typeof rows[0].ts, 'number', 'ts 必须是数值，排序和算差值要用');
    assert.ok(Number.isInteger(rows[0].ts), '毫秒数要是整数');
    assert.equal(rows[0].ts, NAME_AT.getTime());
    assert.match(rows[0].time, /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('search --json 的会话级与消息级时间都可机读', async () => {
  const home = await fixture();
  try {
    const hits = await cli(home, ['search', '海参', '--source', 'codex', '--json']);
    assert.equal(hits.length, 1);
    assert.equal(typeof hits[0].ts, 'number');
    // search 已经解析过文件，用会话内第一条消息的时间，比文件名里的 rollout 时间
    // 更贴近真实起点；list 不解析正文，只能退回文件名时间，两者差几秒属正常。
    assert.equal(hits[0].ts, Date.parse('2026-11-13T02:00:01.000Z'));

    const m = hits[0].matched[0];
    assert.equal(m.role, 'user');
    // 原来这里是 '23:19' 这种只有时分的值，没有日期就跨不了天
    assert.match(m.time, /^\d{4}-\d{2}-\d{2}T/, '消息时间要带日期');
    assert.equal(typeof m.ts, 'number');
    assert.equal(m.ts, Date.parse('2026-11-13T02:00:01.000Z'));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
