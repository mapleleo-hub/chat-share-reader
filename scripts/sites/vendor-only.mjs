// 只通过 Convolvger 读的站点：DeepSeek、Kimi、Qwen、Perplexity 等。
// 本 skill 没有这些站的自有实现，也没有必要写，Convolvger 已经覆盖且实测过。
import * as vendor from '../lib/vendor.mjs';

export const name = 'vendor-only';
export const channel = 'vendor';
export const useVendor = true;

const HOSTS = [
  'chat.deepseek.com',
  'kimi.ai',
  'kimi.com',
  'kimi.moonshot.cn',
  'chat.qwen.ai',
  'chat.qwenlm.ai',
];

export const match = (url) => {
  try {
    const host = new URL(url).hostname.replace(/^www\./, '');
    return HOSTS.includes(host);
  } catch {
    return false;
  }
};

// 走到这里说明 vendor 通道不可用（没装 / 调用失败），只能如实报错
export async function read() {
  throw new Error(
    '这个站点只有 Convolvger 通道，本机没有可用的 convolvger。' +
      '安装：uv venv E:/01-project/05_shared-resource/convolvger --python 3.13 && ' +
      'uv pip install --python E:/01-project/05_shared-resource/convolvger convolvger'
  );
}
