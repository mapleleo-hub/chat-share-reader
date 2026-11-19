// 批量导出与消息定位的回归测试。
//
// 三件事坏了都不报错，只能靠测试挡：
//   1. 角色名又被写成显示名（用户 / Codex），下游按 role 分组时会静默错位
//   2. Codex 的 fork 分片把父线程历史整段复制，按文件导会让同一句话计数两遍
//   3. guardian_review 审批子会话混进批量结果，227 个空会话摊在每个使用者身上
//
// 用 CSR_HOME 指到一个临时家目录，构造最小 codex 会话树，不读真机上任何数据。

import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PARENT = '01a1af92-aaaa-4bbb-8ccc-000000000001';
const FORK = '01a1af92-aaaa-4bbb-8ccc-000000000002';
const GUARDIAN = '01a1af92-aaaa-4bbb-8ccc-000000000003';
const OLD = '01a1af92-aaaa-4bbb-8ccc-000000000004';

const ev = (obj) => JSON.stringify(obj);

function meta(sessionId, { threadSource = 'user', type = 'session_meta' } = {}) {
  if (type === 'session-meta') return ev({ type, sessionId });
  return ev({
    timestamp: '2026-11-13T02:00:00.000Z',
    type: 'session_meta',
    payload: { session_id: sessionId, id: sessionId, cwd: '/w/demo', thread_source: threadSource },
  });
}

const msg = (kind, text, at) =>
  ev({
    timestamp: at,
    type: 'event_msg',
    payload: { type: 'item_completed', item: { type: kind, content: [{ text }] } },
  });

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), 'csr-dump-'));
  const dir = path.join(home, '.codex', 'sessions', '2026', '11', '13');
  await mkdir(dir, { recursive: true });

  // 父会话：一问一答
  const parent = path.join(dir, `rollout-2026-11-13T10-00-00-${PARENT}.jsonl`);
  await writeFile(
    parent,
    [
      meta(PARENT),
      msg('UserMessage', '第一句提问', '2026-11-13T02:00:01.000Z'),
      msg('AgentMessage', '第一句回答', '2026-11-13T02:00:05.000Z'),
    ].join('\n') + '\n',
    'utf8'
  );

  // fork 分片：复制父线程历史，再接自己的两轮，session_meta 仍是父线程 id
  const fork = path.join(dir, `rollout-2026-11-13T10-05-00-${FORK}.jsonl`);
  await writeFile(
    fork,
    [
      meta(PARENT),
      msg('UserMessage', '第一句提问', '2026-11-13T02:00:01.000Z'),
      msg('AgentMessage', '第一句回答', '2026-11-13T02:00:05.000Z'),
      msg('UserMessage', '分叉后追问', '2026-11-13T02:01:00.000Z'),
      msg('AgentMessage', '分叉后回答', '2026-11-13T02:01:05.000Z'),
    ].join('\n') + '\n',
    'utf8'
  );

  // 守护审批子会话：挂在父会话上（session_id 与父会话相同，实测就是这个形态），
  // 整份只有审批回执，没有一行对话
  const guardian = path.join(dir, `rollout-2026-11-13T09-00-00-${GUARDIAN}.jsonl`);
  await writeFile(
    guardian,
    [
      meta(PARENT, { threadSource: 'guardian_review' }),
      msg('AgentMessage', '{"risk_level":"low","outcome":"allow"}', '2026-11-13T01:00:01.000Z'),
      msg('AgentMessage', '{"risk_level":"low","outcome":"allow"}', '2026-11-13T01:00:02.000Z'),
    ].join('\n') + '\n',
    'utf8'
  );

  // 一场旧会话，用来验 --since
  const old = path.join(dir, `rollout-2020-01-01T10-00-00-${OLD}.jsonl`);
  await writeFile(
    old,
    [meta(OLD), msg('UserMessage', '很久以前', '2020-01-01T02:00:01.000Z')].join('\n') + '\n',
    'utf8'
  );
  const oldAt = new Date('2020-01-01T02:00:00Z');
  await utimes(old, oldAt, oldAt);

  return { home, dir, parent, fork, guardian, old };
}

async function cli(home, args) {
  const env = { ...process.env, CSR_HOME: home, CSR_LANG: 'zh', NO_PROXY: '127.0.0.1,localhost' };
  try {
    const { stdout, stderr } = await run(process.execPath, [path.join(root, 'scripts', 'sessions.mjs'), ...args], {
      cwd: root,
      env,
      timeout: 60000,
      maxBuffer: 32 * 1024 * 1024,
    });
    return { code: 0, stdout, stderr };
  } catch (e) {
    return { code: e.code, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

const lines = (stdout) =>
  stdout
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));

test('dump --jsonl 一台机器只出一条消息流：fork 历史不重复计数', async () => {
  const f = await fixture();
  try {
    // fixture 里另有一场 2020 年的会话，--since 把它排掉，只看 fork 合并
    const r = await cli(f.home, ['dump', '--jsonl', '--source', 'codex', '--since', '2026-01-01']);
    assert.equal(r.code, 0, r.stderr);
    const recs = lines(r.stdout);
    assert.ok(recs.length > 0, r.stderr);

    const bodies = recs.map((x) => x.body);
    assert.deepEqual(bodies.filter((b) => b === '第一句提问').length, 1, '父线程历史只该出现一次');
    assert.deepEqual(bodies.filter((b) => b === '第一句回答').length, 1);
    assert.ok(bodies.includes('分叉后追问'));
    assert.ok(bodies.includes('分叉后回答'));

    // 父子分片同属一个 family，下游按 family 计数才等于会话数
    const families = new Set(recs.map((x) => x.family));
    assert.deepEqual([...families], [PARENT]);
    assert.ok(recs.every((x) => x.session === PARENT));

    // 两个分片都要被标出来，且序号在家族内自洽
    const shards = new Set(recs.map((x) => x.shard));
    assert.equal(shards.size, 2);
    assert.ok(recs.every((x) => x.shard_count === 2));
    assert.ok(recs.some((x) => x.shard_index === 1));
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('dump --jsonl 每条消息带机器角色、序号与指纹', async () => {
  const f = await fixture();
  try {
    const r = await cli(f.home, ['dump', '--jsonl', '--source', 'codex', '--redact', 'off', '--since', '2026-01-01']);
    const recs = lines(r.stdout);
    const roles = new Set(recs.map((x) => x.role));
    assert.deepEqual([...roles].sort(), ['assistant', 'user']);
    assert.ok(recs.every((x) => ['user', 'assistant', 'tool', 'system'].includes(x.role)));
    // 显示名另放，且与机器角色是两套值
    assert.ok(recs.some((x) => x.speaker === '用户'));
    assert.deepEqual(recs.map((x) => x.msg_index), [0, 1, 2, 3]);
    assert.ok(recs.every((x) => /^[0-9a-f]{16}$/.test(x.hash)));
    assert.ok(recs.every((x) => x.ts && x.source === 'codex' && x.session_type === 'user'));
    // 同一句话在不同时间点指纹必须一致，否则重跑去不掉重
    const same = recs.filter((x) => x.body === '分叉后追问');
    assert.equal(same.length, 1);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('dump 默认按类型跳过 guardian_review，导出时说明原因', async () => {
  const f = await fixture();
  try {
    const r = await cli(f.home, ['dump', '--jsonl', '--source', 'codex']);
    assert.ok(!r.stdout.includes(GUARDIAN), 'guardian 分片不该出现在任何记录里');
    assert.ok(/按类型跳过 1 个分片（guardian_review 1）/.test(r.stderr), r.stderr);

    // --no-skip 把审批分片读进来：它没有对话正文，所以消息数不变、也不会多出一场会话
    const noisy = await cli(f.home, ['dump', '--jsonl', '--source', 'codex', '--no-skip']);
    assert.equal(noisy.code, 0, noisy.stderr);
    assert.ok(/按类型跳过 0 个分片/.test(noisy.stderr), noisy.stderr);
    assert.ok(!noisy.stdout.includes('risk_level'), '审批回执不该进消息流');

    const one = await cli(f.home, ['export', GUARDIAN, '--stdout']);
    assert.equal(one.code, 1);
    assert.ok(one.stderr.includes('guardian_review'), one.stderr);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('dump --since 按 mtime 增量，旧会话不出现', async () => {
  const f = await fixture();
  try {
    const blocked = await cli(f.home, ['dump', '--jsonl', '--source', 'codex', '--since', '2026-01-01']);
    assert.ok(!blocked.stdout.includes('很久以前'));
    assert.ok(blocked.stdout.includes('第一句提问'));

    const all = await cli(f.home, ['dump', '--jsonl', '--source', 'codex', '--since', '2000-01-01']);
    assert.ok(all.stdout.includes('很久以前'));

    const bad = await cli(f.home, ['dump', '--jsonl', '--since', '上个月']);
    assert.equal(bad.code, 1);
    assert.ok(bad.stderr.includes('看不懂'), bad.stderr);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('export --json 带会话定位字段，角色可机读', async () => {
  const f = await fixture();
  try {
    const r = await cli(f.home, ['export', PARENT, '--json', '--redact', 'off']);
    assert.equal(r.code, 0, r.stderr);
    const j = JSON.parse(r.stdout);
    assert.equal(j.source, 'codex');
    assert.equal(j.session, PARENT);
    assert.equal(j.session_type, 'user');
    assert.deepEqual(j.messages.map((m) => m.role), ['user', 'assistant', 'user', 'assistant']);
    assert.deepEqual(j.messages.map((m) => m.msg_index), [0, 1, 2, 3]);
    assert.ok(j.messages.every((m) => m.session === PARENT && /^[0-9a-f]{16}$/.test(m.hash)));
    assert.ok(j.messages.every((m) => typeof m.speaker === 'string' && m.speaker));
    assert.equal(j.segments.length, 2);
    assert.ok(j.messages.every((m) => j.segments.includes(m.shard)));
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});

test('dump --json 一场会话一行，messages 嵌在记录里', async () => {
  const f = await fixture();
  try {
    const r = await cli(f.home, ['dump', '--json', '--source', 'codex', '--since', '2026-01-01']);
    const recs = lines(r.stdout);
    assert.equal(recs.length, 1);
    assert.equal(recs[0].kind, 'session');
    assert.equal(recs[0].family, PARENT);
    assert.equal(recs[0].msg_count, 4);
    assert.equal(recs[0].messages.length, 4);
    assert.equal(recs[0].shards.length, 2);
  } finally {
    await rm(f.home, { recursive: true, force: true });
  }
});
