// 角色归一化与消息定位的单元测试。
//
// 这层是给下游做键用的：机器角色一旦漏回显示名（用户 / Codex），下游按角色分组
// 不会报错，只会在换模型或换界面语言那天悄悄错位。

import test from 'node:test';
import assert from 'node:assert/strict';
import { machineRole, MACHINE_ROLES } from '../scripts/lib/roles.mjs';
import { fingerprint, parseSince, stampOf } from '../scripts/lib/provenance.mjs';

test('解析器实际产出的显示名都落到四个机器角色里', () => {
  const seen = ['Claude', 'Codex', 'WorkBuddy', 'Agent', 'Cursor', 'pi', 'Gemini', '课堂笔记', '逐字稿'];
  for (const name of seen) assert.equal(machineRole(name), 'assistant', name);
  assert.equal(machineRole('用户'), 'user');
  assert.equal(machineRole('User'), 'user');
  assert.equal(machineRole('human'), 'user');
});

test('工具与系统显式归类，认不出的一律当 assistant', () => {
  for (const n of ['工具', '工具结果', '工具调用', 'Tool', 'tool_result']) assert.equal(machineRole(n), 'tool', n);
  for (const n of ['系统', 'system', 'developer']) assert.equal(machineRole(n), 'system', n);
  assert.equal(machineRole('思考'), 'assistant');
  assert.equal(machineRole(''), 'assistant');
  assert.equal(machineRole(undefined), 'assistant');
  assert.equal(machineRole('品牌新模型'), 'assistant');
});

test('机器角色本身幂等', () => {
  for (const r of MACHINE_ROLES) assert.equal(machineRole(r), r, r);
});

test('指纹按原文算，与本机脱敏档位无关', () => {
  const body = '看 C:\\Users\\alice\\demo 这个报错';
  assert.equal(fingerprint(body), fingerprint('  ' + body + '\n'));
  assert.notEqual(fingerprint(body), fingerprint(body + '。'));
  assert.match(fingerprint(body), /^[0-9a-f]{16}$/);
});

test('时间戳有 ISO 用 ISO，只有时分就原样给，不补假日期', () => {
  assert.equal(stampOf({ at: '2026-11-13T02:00:01.000Z', time: '02:00' }), '2026-11-13T02:00:01.000Z');
  assert.equal(stampOf({ time: '02:00' }), '02:00');
  assert.equal(stampOf({}), '');
});

test('parseSince 认日期、相对量与毫秒，认不出报错', () => {
  const now = Date.parse('2026-11-13T00:00:00Z');
  assert.equal(parseSince(''), 0);
  // 纯日期按本地零点，不按 UTC 午夜。ES 规范里 `new Date('2026-11-01')` 是 UTC，
  // 而带时间的写法又是本地，本机 UTC+8 下两者差 8 小时：按 UTC 算，--since
  // 2026-11-01 会漏掉当天本地 00:00–08:00 的会话。用本地构造取值，免时区依赖。
  assert.equal(parseSince('2026-11-01'), new Date(2026, 10, 1).getTime());
  assert.equal(parseSince('2026-11-01T10:30'), new Date(2026, 10, 1, 10, 30).getTime());
  assert.equal(parseSince('7d', now), now - 7 * 86400000);
  assert.equal(parseSince('24h', now), now - 24 * 3600000);
  assert.equal(parseSince('90m', now), now - 90 * 60000);
  assert.equal(parseSince('1700000000000'), 1700000000000);
  assert.throws(() => parseSince('上个月'), /看不懂/);
});
