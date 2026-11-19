// 消息级定位：一条记录要能回答「哪一场、哪个文件、第几条、谁说的、什么时候」。
//
// 只在结构化输出里用（export --json / dump），markdown 不碰。
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
 * 时间原文换算成毫秒。给「程序要拿时间排序 / 算差值」的地方用，展示仍用 fmtTime。
 * HH:MM 这种没有日期的算不出来，返回 null 而不是补一个今天的日期；调用方据此
 * 决定省略这个字段，别把假时间喂给下游。
 *
 * 结果一律取整：有的源自带小数毫秒（文件 mtime 是浮点，实测拿到过
 * 1795075120835.4502），小数部分对排序没有任何用处，还会让下游以为这不是时间戳。
 */
export function epochOf(value) {
  const raw = typeof value === 'number' ? value : parseEpoch(value);
  return Number.isFinite(raw) ? Math.round(raw) : null;
}

function parseEpoch(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (/^\d{11,}$/.test(s)) return Number(s);
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) return null;
  const ms = new Date(s).getTime();
  return Number.isFinite(ms) ? ms : null;
}

/**
 * 一条消息的定位字段。正文与 chars 由调用方补，body 传进来时按实际的
 * 输出正文（可能已脱敏）算长度。
 *
 * 没有 family：Codex 的 fork 分片跟父线程共用同一个 session_id，归组用的就是它，
 * 「会话」和「家族」永远是同一个值。留一个恒等的字段只会让下游以为能分两层。
 */
export function messageRecord({ source, session, shard, shardIndex, shardCount, index, message, body }) {
  const text = body == null ? String(message.body || '') : String(body);
  const rec = {
    source: source || '',
    session: session || '',
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
  // 纯日期补本地零点再解析。ES 规范里 `new Date('2026-11-01')` 是 UTC 午夜，
  // 而 `new Date('2026-11-01T10:30')` 是本地时间，同一份代码两种口径：本机 UTC+8，
  // `--since 2026-11-01` 实际从本地 08:00 起算，当天 00:00–08:00 的会话全被漏掉。
  // 用户说的是本地日历日，两种写法统一按本地。
  const ms = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + 'T00:00' : s).getTime();
  if (!Number.isFinite(ms)) throw new Error('看不懂这个时间：' + s + '（要 2026-11-01、7d、24h 或毫秒时间戳）');
  return ms;
}
