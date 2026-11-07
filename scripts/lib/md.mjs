// markdown 拼装与通用小工具

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

export function buildDoc({ title, url, source, channel, messages, note }) {
  const chars = messages.reduce((n, m) => n + m.body.length, 0);
  const lines = [`# ${title}`, ''];
  lines.push(`- 来源：${url}`);
  if (source) lines.push(`- 数据接口：${source}`);
  if (channel) lines.push(`- 抓取通道：${channel}`);
  lines.push(`- 抓取时间：${fmtTime(Date.now())}`);
  lines.push(`- 消息条数：${messages.length}`);
  lines.push(`- 字符数：${chars}`);
  lines.push('');
  if (note) lines.push(`> ${note}`, '');
  for (const m of messages) {
    lines.push('');
    lines.push(`## ${m.role}${m.time ? ' · ' + m.time : ''}`);
    lines.push('');
    lines.push(m.body.trim());
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
