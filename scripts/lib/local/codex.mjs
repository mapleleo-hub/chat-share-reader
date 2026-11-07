// Codex CLI 本地会话解析（~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl）。
//
// 一行一个事件：session_meta / response_item / event_msg / turn_context / world_state /
// token_usage_record。对话正文在 event_msg 且 payload.type === "item_completed" 里，
// item.type 为 UserMessage 或 AgentMessage。这是最干净的口径。
//
// 不要用 response_item/message：那里混着 role 为 developer 的系统提示和记忆注入，
// 直接取会把几千字的内部指令当成对话内容。
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const source = 'codex';

export async function parse(file, { full = false } = {}) {
  const raw = await readFile(file, 'utf8');
  const events = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      events.push(JSON.parse(s));
    } catch {
      /* 忽略 */
    }
  }

  const messages = [];
  let cwd = '';
  let sessionId = '';
  let model = '';
  let git = '';

  for (const ev of events) {
    if (ev.type === 'session_meta' && ev.payload) {
      cwd = cwd || ev.payload.cwd || '';
      sessionId = sessionId || ev.payload.session_id || ev.payload.id || '';
      model = model || ev.payload.model_provider || '';
      git = git || (ev.payload.git && ev.payload.git.branch) || '';
      continue;
    }

    if (ev.type === 'turn_context' && ev.payload) {
      model = ev.payload.model || model;
      continue;
    }

    // 正文
    if (ev.type === 'event_msg' && ev.payload && ev.payload.type === 'item_completed') {
      const item = ev.payload.item || {};
      if (item.type !== 'UserMessage' && item.type !== 'AgentMessage') continue;
      const text = (item.content || [])
        .map((c) => (c && (c.text || c.Text)) || '')
        .join('\n')
        .trim();
      if (!text) continue;
      messages.push({
        role: item.type === 'UserMessage' ? '用户' : 'Codex',
        time: ev.timestamp ? String(ev.timestamp).slice(11, 16) : '',
        body: text,
      });
      continue;
    }

    // 可选：思考与工具调用
    if (!full) continue;
    if (ev.type === 'response_item' && ev.payload) {
      const p = ev.payload;
      if (p.type === 'reasoning') {
        const t = (p.content || p.summary || [])
          .map((c) => (c && (c.text || c.Text)) || '')
          .join('\n')
          .trim();
        if (t) messages.push({ role: '思考', time: '', body: '> ' + t.split('\n').join('\n> ') });
      } else if (p.type === 'custom_tool_call') {
        messages.push({
          role: '工具',
          time: '',
          body: '**调用** `' + (p.name || '') + '`\n\n```\n' + String(p.input || '').slice(0, 2000) + '\n```',
        });
      } else if (p.type === 'custom_tool_call_output') {
        messages.push({
          role: '工具结果',
          time: '',
          body: '```\n' + String(p.output || '').slice(0, 4000) + '\n```',
        });
      }
    }
  }

  return {
    title: titleOf(messages) || path.basename(file, '.jsonl'),
    messages,
    source: file,
    note: [model && 'provider ' + model, cwd && '目录 ' + cwd, git && '分支 ' + git]
      .filter(Boolean)
      .join('｜'),
    meta: { sessionId, cwd, branch: git, model },
  };
}

function titleOf(messages) {
  const first = messages.find((m) => m.role === '用户');
  if (!first) return '';
  return first.body
    .replace(/[#*`>\n]/g, ' ')
    .replace(/[，。、？！；："'（）《》…—\s]+/g, ' ')
    .trim()
    .slice(0, 24)
    .trim();
}
