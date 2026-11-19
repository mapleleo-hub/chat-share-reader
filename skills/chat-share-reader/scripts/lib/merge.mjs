// 分片合并。
//
// Codex 的 fork 会把一个线程写成十几个 rollout 文件，文件名各用新 id，
// 但每个文件的 session_meta 里都复制着父线程的 id。所以「哪些文件属于同一场对话」
// 只能靠读文件里的 id，不能靠文件名或 mtime。
//
// 这层逻辑从 sessions.mjs 抽出来，是为了能单独测：真出过错的地方就在这里，
// 拼错一次读者看到的是顺序错乱、内容重复的对话。

/**
 * 同一场对话的分片可能被收集两次（id 前缀命中一次、文件名命中一次），
 * 按文件路径去重，并保持时间升序。
 */
export function dedupeShards(list) {
  const sorted = [...list].sort((a, b) => (a.time || 0) - (b.time || 0));
  const seen = new Set();
  const out = [];
  for (const x of sorted) {
    const k = x.file || String(x.ref);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

/**
 * 把同族分片补齐。
 *
 * @param picked  已命中的分片，第一项是种子
 * @param items   同类来源下的全部候选项
 * @param idOf    读文件拿真实线程 id 的函数；测试里传桩，线上传 sessionIdOf
 * @param deep    true 时总是逐个读文件头比对，不只靠文件名。
 *                只靠文件名会漏：子代理分片常常只用自己的新 id 命名（实测一场会话
 *                文件名能收到 5 个分片，而按 session_meta 比实际有 14 个），
 *                漏了就会少导消息，导出的 segments 也点不全。读文件头很便宜
 *                （只读前几行，压缩文件读到第一块就停），所以导出时走 deep。
 */
export async function expandShards(picked, items, idOf, { deep = false } = {}) {
  const seed = picked[0];
  const seedSid = await idOf(seed.file || String(seed.ref));
  if (!seedSid) return dedupeShards(picked);

  const sameSource = items.filter(
    (it) => it.file && it.source === seed.source && !picked.includes(it)
  );

  // 文件名里带父线程 id 的分片，先按路径收，不用开文件
  for (const it of sameSource) {
    if (String(it.file).includes(seedSid)) picked.push(it);
  }

  // 一个都没补到，说明分片换了名字，这时才逐个读文件头比对；deep 时总是读。
  // 放在条件里是为了不让普通导出每次都全量扫一遍候选目录。
  if (deep || picked.length <= 1) {
    for (const it of sameSource) {
      if (picked.includes(it)) continue;
      if ((await idOf(it.file)) === seedSid) picked.push(it);
    }
  }
  return dedupeShards(picked);
}

/**
 * 把多个分片的解析结果拼成一条消息流。
 *
 * 去重键取 role + 正文前 300 字：fork 分片会整段复制父线程的历史，
 * 正文完全相同，但时间戳可能一致也可能差几秒。
 *
 * @param results  [{ note, messages }]
 */
export function stitchMessages(results) {
  const merged = [];
  const seen = new Set();
  let note = '';

  for (const r of results) {
    note = note || r.note || '';
    for (const m of r.messages || []) {
      const key = m.role + '|' + String(m.body || '').slice(0, 300);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(m);
    }
  }

  // 分片按文件 mtime 拼不可靠（fork 会重写文件），按消息自带的 ISO 时间排。
  // 工具消息没有时间，继承上一条的，否则会被甩到最前面。
  let carry = '';
  for (const m of merged) {
    if (m.at) carry = m.at;
    else m.__sort = carry;
  }
  merged.sort((a, b) =>
    String(a.at || a.__sort || '').localeCompare(String(b.at || b.__sort || ''))
  );

  return { messages: merged, note };
}
