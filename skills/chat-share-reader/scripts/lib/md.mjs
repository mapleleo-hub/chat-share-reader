// markdown 拼装与通用小工具

import { t, role, isZh } from './i18n.mjs';

export function fmtTime(value) {
  if (!value) return '';
  let ms;
  if (typeof value === 'number') ms = value > 1e12 ? value : value * 1000;
  else ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return '';
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getFullYear())}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 短格式，只要时分（同一场对话用）
export function fmtClock(value) {
  const full = fmtTime(value);
  return full ? full.slice(11) : '';
}

export function safeName(s) {
  return (s || 'untitled')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
}

// 正文里的标题降两级。消息本身占 h2，正文里的 h1/h2 如果原样保留，
// 会和角色标题同级甚至更高，整篇大纲就乱了。围栏代码块内的 # 不动。
export function demoteHeadings(text) {
  const lines = String(text).split('\n');
  let fence = false;
  return lines
    .map((line) => {
      if (/^\s*```/.test(line)) {
        fence = !fence;
        return line;
      }
      if (fence) return line;
      const m = line.match(/^(#{1,6})\s+/);
      if (!m) return line;
      const level = Math.min(m[1].length + 2, 6);
      return '#'.repeat(level) + line.slice(m[1].length);
    })
    .join('\n');
}

export function buildDoc({ title, url, source, channel, messages, note }) {
  const chars = messages.reduce((n, m) => n + m.body.length, 0);
  const sep = isZh ? '：' : ': ';
  const field = (zh, en, v) => `- ${t(zh, en)}${sep}${v}`;
  const lines = [`# ${title}`, ''];
  lines.push(field('来源', 'Source', url));
  if (source) lines.push(field('数据接口', 'Endpoint', source));
  if (channel) lines.push(field('抓取通道', 'Channel', channel));
  lines.push(field('抓取时间', 'Fetched at', fmtTime(Date.now())));
  lines.push(field('消息条数', 'Messages', messages.length));
  lines.push(field('字符数', 'Characters', chars));
  lines.push('');
  if (note) lines.push(`> ${note}`, '');
  for (const m of messages) {
    // 合并多个 rollout 分片时会跨天，只有 HH:MM 分不清先后，有 at 就上完整日期
    const stamp = m.at ? fmtTime(m.at) : m.time;
    lines.push('');
    lines.push(`## ${role(m.role)}${stamp ? ' · ' + stamp : ''}`);
    lines.push('');
    lines.push(demoteHeadings(m.body.trim()));
  }
  return lines.join('\n') + '\n';
}

export function normalizeMessages(list) {
  return list
    .map((m) => ({ ...m, body: (m.body || '').trim() }))
    .filter((m) => m.body);
}

// 从混杂输出里挖出第一个完整 JSON 对象或数组
export function pickJson(text) {
  const s = String(text);
  const start = Math.min(
    ...[s.indexOf('{'), s.indexOf('[')].filter((i) => i >= 0)
  );
  if (!Number.isFinite(start)) throw new Error('输出里没有 JSON：' + s.slice(0, 200));
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  return JSON.parse(s.slice(start, end + 1));
}
