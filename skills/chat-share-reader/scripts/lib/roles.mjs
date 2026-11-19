// 角色归一化：机器可读角色与显示名分开。
//
// 解析器里 message.role 存的是显示名（用户 / Claude / Codex / WorkBuddy / 工具 …），
// 它随界面语言和模型名变化。下游拿它区分说话人时会在换模型、换语言那天静默错位，
// 所以输出层统一收敛成四个稳定值：user / assistant / tool / system。
//
// 约定：解析器写「用户」或 user 表示用户发言，其余一律算模型侧（assistant）；
// 工具与系统只有显式列在这里的名字才归类，避免把新的模型名误判成工具。
// 新增解析器只要沿用这个约定，不用改本文件。
export const MACHINE_ROLES = ['user', 'assistant', 'tool', 'system'];

const USER = new Set(['user', '用户', 'human', '提问', 'question']);
const TOOL = new Set([
  'tool',
  'tools',
  'tool_call',
  'tool_result',
  'tool call',
  'tool result',
  '工具',
  '工具调用',
  '工具结果',
]);
const SYSTEM = new Set(['system', 'developer', 'system_prompt', '系统', '系统提示']);

/** 显示名 -> user|assistant|tool|system。认不出的一律当 assistant。 */
export function machineRole(name) {
  const key = String(name == null ? '' : name).trim().toLowerCase();
  if (USER.has(key)) return 'user';
  if (TOOL.has(key)) return 'tool';
  if (SYSTEM.has(key)) return 'system';
  return 'assistant';
}

/** 已经是机器角色就原样返回，显示名则翻译一次。给读归一化后的消息用。 */
export function isMachineRole(value) {
  return MACHINE_ROLES.includes(String(value || '').trim().toLowerCase());
}
