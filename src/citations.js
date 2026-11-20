// 原文引用工具：所有判断都必须能回溯到资料记录中的原句片段。
// 使用正则的 /d 旗标取得字符区间，引用文本直接从原文切片，不改写、不翻译。

/**
 * @typedef {Object} Ref 原文定位
 * @property {string} record 资料记录编号（如 r1、s3、v2）
 * @property {string} quote  原样保留的原文片段
 * @property {[number, number]} range 在该记录 text 中的字符区间
 */

/**
 * 从原文切出一个引用。
 * @param {string} recordId
 * @param {string} text 记录原文
 * @param {number} start
 * @param {number} end
 * @returns {Ref}
 */
export function makeRef(recordId, text, start, end) {
  return { record: recordId, quote: text.slice(start, end), range: [start, end] };
}

/**
 * 列出正则在原文中的全部匹配（需带 /d 旗标），返回引用与捕获组。
 * @param {string} text
 * @param {RegExp} regex 必须带全局标志 g 与 indices 标志 d
 * @returns {Array<{ ref: Ref, groups: string[] }>}
 */
export function matchAllWithIndices(text, regex) {
  if (!regex.flags.includes('d') || !regex.flags.includes('g')) {
    throw new TypeError('matchAllWithIndices 需要 /gd 正则');
  }
  const out = [];
  for (const match of text.matchAll(regex)) {
    const [start, end] = match.indices[0];
    const groups = match.slice(1).map(group => group ?? '');
    out.push({ ref: makeRef('', text, start, end), groups });
  }
  return out;
}

/** 把一组 Ref 按记录编号去重（同一原句不重复列印）。 */
export function uniqueRefs(refs) {
  const seen = new Set();
  const out = [];
  for (const ref of refs) {
    const key = `${ref.record}:${ref.range[0]}-${ref.range[1]}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(ref);
    }
  }
  return out;
}
