// 解析场馆提交的资源/路段记录（资源.json）。
// 每条记录对应一个路段或活动：入口、步行、接驳、讲解。
// 自然语言限制（雨天停行、须提前安排、视轮椅宽度而定等）解析为带引用的条件。

import { matchAllWithIndices } from './citations.js';

/**
 * @typedef {Object} Condition 路段上的一个条件/限制
 * @property {string} kind   条件种类
 * @property {string} record 来源记录编号
 * @property {string} quote  原文片段（原样保留，含粤语书面词）
 * @property {[number, number]} range
 * @property {Record<string, string|number|boolean>} attrs
 */

const STEPS_RAILS_RE = /([一二两三四五六七八九十\d]+阶[^。；]*?(?:都有扶手|有扶手|须扶手|无扶手))|(无台阶)|(有扶手)|(无扶手)/gdi;
const RAIN_RE = /(?:除雨天外|雨天停行|雨天暂停|除非落雨|落雨停|closed on rainy days)/gdi;
const ADVANCE_RE = /须提前安排|需提前安排|要提前预约|advance (?:arrangement|booking) required/gdi;
const WHEELCHAIR_RE = /可载轮椅|接受(?:两部?|两部?)?轮椅|容纳轮椅|wheelchair(?:s)? (?:accessible|accepted|can be carried)|can carry wheelchairs/gdi;
const FOLD_ONLY_RE = /仅指可折叠(?:型)?轮椅|只限可折叠|仅限折叠(?:型)?|foldable wheelchairs? only/gdi;
const WIDTH_RE = /视轮椅宽度而定|按轮椅宽度|取决于轮椅宽度|depending on wheelchair width/gdi;
const DURATION_RE = /用时([一二两三四五六七八九十\d]+)分钟|([一二两三四五六七八九十\d]+)分钟(?:步行|路程)?|(\d+)\s*minutes/gdi;
const WHOLE_GROUP_RE = /可整团接待|全团同场|整团|whole group/gdi;

const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function num(token) {
  if (!token) return null;
  if (/\d+/.test(token)) return Number(token);
  return CN_NUM[token] ?? null;
}

function collect(text, regex, recordId, kind, build = groups => ({})) {
  return matchAllWithIndices(text, regex).map(hit => ({
    kind,
    record: recordId,
    quote: hit.ref.quote,
    range: hit.ref.range,
    attrs: build(hit.groups)
  }));
}

/**
 * @param {Array<{id:string,type:string,from:string,to:string,slot:string,text:string}>} rows
 * @returns {{ segments: import('./types.js').Segment[], byId: Map<string, import('./types.js').Segment> }}
 */
export function parseSegments(rows) {
  const segments = rows.map(row => {
    const conditions = [];

    for (const c of collect(row.text, STEPS_RAILS_RE, row.id, 'steps-rails', groups => {
      const clause = groups[0] ?? '';
      return {
        stepCount: num(clause.match(/[一二两三四五六七八九十\d]+/)?.[0] ?? groups[0]),
        hasRails: clause ? /扶手/.test(clause) && /有扶手/.test(clause) : null,
        noSteps: Boolean(groups[1])
      };
    })) {
      if (c.quote.includes('无台阶')) c.attrs.noSteps = true;
      conditions.push(c);
    }

    conditions.push(...collect(row.text, RAIN_RE, row.id, 'weather-closure', () => ({
      blockedWhen: 'rain'
    })));
    conditions.push(...collect(row.text, ADVANCE_RE, row.id, 'advance-arrangement', () => ({
      required: true
    })));
    conditions.push(...collect(row.text, WHEELCHAIR_RE, row.id, 'wheelchair-capacity', groups => ({
      claimed: true,
      foldableOnly: false
    })));
    conditions.push(...collect(row.text, FOLD_ONLY_RE, row.id, 'foldable-only', () => ({
      foldableOnly: true
    })));
    conditions.push(...collect(row.text, WIDTH_RE, row.id, 'width-dependent', () => ({
      dependsOn: 'wheelchair-width'
    })));
    conditions.push(...collect(row.text, WHOLE_GROUP_RE, row.id, 'whole-group-reception', () => ({
      wholeGroup: true
    })));
    for (const c of collect(row.text, DURATION_RE, row.id, 'walk-duration', groups => ({
      minutes: num(groups[0] ?? groups[1] ?? groups[2])
    }))) {
      if (c.attrs.minutes !== null) conditions.push(c);
    }

    return {
      id: row.id,
      type: row.type,
      from: row.from,
      to: row.to,
      slot: row.slot,
      slotMinutes: toMinutes(row.slot),
      text: row.text,
      conditions
    };
  });

  const byId = new Map(segments.map(segment => [segment.id, segment]));
  return { segments, byId };
}

/** "13:25" -> 805；无法解析时返回 null。 */
export function toMinutes(slot) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(slot ?? '');
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}
