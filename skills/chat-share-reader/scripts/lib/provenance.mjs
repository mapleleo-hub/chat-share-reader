// 消息级定位：一条记录要能回答「哪一场、哪个文件、第几条、谁说的、什么时候」。
//
// 只在结构化输出里用（export --json / dump --jsonl），markdown 不碰。
// 文件名、分片序号、内容指纹三件一起给，下游才能既定位到原文，又能在重跑时
// 判断这条是不是上次已经收过。
import { createHash } from 'node:crypto';
import { role as displayRole } from './i18n.mjs';
import { machineRole } from './roles.mjs';

// 指纹按原文算，不按脱敏后的正文：同一句话在 home 与 off 两个档位下必须是同一个
// 指纹，否则换个脱敏档位重跑，下游会当成新内容收第二遍。
// 归一化空白是为了让分片重写、换行差异不改变指纹；取前 16 位十六进制，碰撞概率够低。
export function fingerprint(body) {
  const norm = String(body == null ? '' : body)
    .replace(/\s+/g, ' ')
    .trim();
  return createHash('sha256').update(norm, 'utf8').digest('hex').slice(0, 16);
}

// 消息时间。有 ISO 就用 ISO；解析器只给了 HH:MM 的（Cursor、Codex 正文事件）就原样
// 给，不拿今天的日期去补一个假时间。
export function stampOf(m) {
  return String((m && (m.at || m.time)) || '');
}

/**
 * 一条消息的定位字段。正文与 chars 由调用方补，body 传进来时按实际的
 * 输出正文（可能已脱敏）算长度。
 */
export function messageRecord({ source, session, family, shard, shardIndex, shardCount, index, message, body }) {
  const text = body == null ? String(message.body || '') : String(body);
  const rec = {
    source: source || '',
    session: session || '',
    family: family || session || '',
    msg_index: index,
    role: machineRole(message.role),
    speaker: displayRole(message.role),
    ts: stampOf(message),
    chars: text.length,
    hash: fingerprint(message.body),
  };
  if (shard) rec.shard = shard;
  if (shardCount > 1) {
    rec.shard_index = shardIndex || 0;
    rec.shard_count = shardCount;
  }
  return rec;
}

/**
 * --since 的取值：'2026-11-01'、'2026-11-01T10:30'、'7d' / '24h' / '90m' / '2w'、
 * 或者 10 位以上的毫秒时间戳。认不出直接报错，不要静默当成 0 把全部会话都导出。
 */
export function parseSince(value, now = Date.now()) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return 0;
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*(m|h|d|w)$/i);
  if (rel) {
    const unit = { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[rel[2].toLowerCase()];
    return now - Number(rel[1]) * unit;
  }
  if (/^\d{11,}$/.test(s)) return Number(s);
  const ms = new Date(s).getTime();
  if (!Number.isFinite(ms)) throw new Error('看不懂这个时间：' + s + '（要 2026-11-01、7d、24h 或毫秒时间戳）');
  return ms;
}
