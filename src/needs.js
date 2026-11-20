// 解析团方需求记录（需求.json）。
// 粤语书面词、普通话与英文近义表达映射到同一组硬性需求/偏好，
// 但每条都带原句引用，解释时必须原样呈现。

import { matchAllWithIndices } from './citations.js';

/**
 * @typedef {Object} Need 一条被识别出的需求
 * @property {string} kind      需求种类
 * @property {'hard'|'soft'|'conditional'} strength
 *   hard=硬性需求，soft=可舍弃的偏好，conditional=附条件的注意事项
 * @property {string} group     所属同行组
 * @property {string} record    来源记录编号
 * @property {string} quote     原文片段（原样保留）
 * @property {[number, number]} range 原文区间
 * @property {Record<string, string|number|boolean>} attrs 结构化属性
 */

const WHEELCHAIR_RE = /(两部?|二部?|\d+)\s*部?轮椅|(\d+)\s*wheelchairs?/gdi;
const FOLDABLE_RE = /只有(一)部?摺得埋|摺得埋|可折叠|fold(?:able)?|can be folded/gdi;
const NONFOLDABLE_RE = /不能折叠|唔可以摺|无法折叠|cannot be folded|non[- ]?fold/gdi;
const ACCOMPANY_RE = /一定要同带队老师一齐去|不能和老师分开|唔可以同老师分开|must stay with|cannot be separated from/gdi;
const SHORT_WALK_RE = /短距离步行|能短距离步行|可以短距离步行|沿连廊步行|short walk|short distance/gdi;
const STEPS_RAILS_RE = /有台阶要有扶手|台阶需有扶手|台阶都有扶手|steps? with rails|rails?.*steps?/gdi;
const LIFT_PREFER_RE = /有电梯会更好|希望有电梯|lift would be preferable|prefer(?:able)? (?:a )?lift/gdi;
const CN_HOUR_CLASS = '[一二两三四五六七八九十\\d]';
const SLOT_START_RE = new RegExp(`(下午|上午)?(${CN_HOUR_CLASS}+)点(?!(?:${CN_HOUR_CLASS}+)点)`, 'gdi');
const SLOT_RANGE_RE = new RegExp(`(${CN_HOUR_CLASS}+)点到(?:(?:下午|上午))?(${CN_HOUR_CLASS}+)点`, 'gd');
const SLOT_EN_RANGE_RE = /from\s+(\d{1,2})\s*(?:am|pm)?\s*to\s+(\d{1,2})\s*(?:am|pm)?/gdi;

const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function toHour(token, meridiem) {
  if (!token) return null;
  let hour = /\d+/.test(token) ? Number(token) : CN_NUM[token];
  if (!Number.isFinite(hour)) return null;
  if (meridiem === '下午' && hour < 12) hour += 12;
  return hour;
}

function findOne(text, regex, recordId) {
  const hits = matchAllWithIndices(text, regex);
  return hits.map(hit => ({ ...hit.ref, record: recordId, groups: hit.groups }));
}

/**
 * 把一组需求记录解析为按同行组聚合的需求清单。
 * @param {Array<{id:string, group:string, locale:string, text:string}>} rows
 * @returns {{ groups: Map<string, Need[]>, all: Need[] }}
 */
export function parseNeeds(rows) {
  const all = [];
  const push = (group, recordId, text, hit, kind, strength, attrs = {}) => {
    all.push({
      kind,
      strength,
      group,
      record: recordId,
      quote: hit.quote ?? text.slice(hit.range[0], hit.range[1]),
      range: hit.range,
      attrs
    });
  };

  for (const row of rows) {
    const { id, group, text } = row;

    // 轮椅规模与可折叠情况：硬性需求
    const foldHits = findOne(text, FOLDABLE_RE, id);
    const nonFoldHits = findOne(text, NONFOLDABLE_RE, id);
    for (const hit of matchAllWithIndices(text, WHEELCHAIR_RE)) {
      const countToken = hit.groups[0] || hit.groups[1] || '';
      const count = countToken.includes('两') || countToken.includes('二') ? 2
        : /\d+/.test(countToken) ? Number((countToken.match(/\d+/) ?? ['1'])[0])
        : 1;
      // “只有一部摺得埋”= 仅一部可折叠，其余不能折叠
      const onlyOneFoldable = foldHits.some(h => /只有/.test(text) && h.groups[0] === '一');
      push(group, id, text, { ...hit.ref, record: id }, 'wheelchair-fleet', 'hard', {
        count,
        foldableCount: onlyOneFoldable ? 1 : null,
        nonFoldableCount: onlyOneFoldable ? Math.max(0, count - 1) : null
      });
    }
    for (const hit of nonFoldHits) {
      push(group, id, text, hit, 'non-foldable-wheelchair', 'hard', {});
    }

    // 同行约束：硬性需求，作用于分组与交通段/场次选择
    for (const hit of findOne(text, ACCOMPANY_RE, id)) {
      push(group, id, text, hit, 'accompany-teacher', 'hard', {
        scope: 'same-transport-and-session'
      });
    }

    // 短距离步行：硬性需求（步行段距离必须可证）
    for (const hit of findOne(text, SHORT_WALK_RE, id)) {
      push(group, id, text, hit, 'short-walk', 'hard', {});
    }

    // 台阶需扶手：硬性需求
    for (const hit of findOne(text, STEPS_RAILS_RE, id)) {
      push(group, id, text, hit, 'steps-with-rails', 'hard', {});
    }

    // 电梯只是偏好，可舍弃并说明
    for (const hit of findOne(text, LIFT_PREFER_RE, id)) {
      push(group, id, text, hit, 'lift-preference', 'soft', {});
    }

    // 讲解时段窗口：硬性需求
    const rangeHit = matchAllWithIndices(text, SLOT_RANGE_RE)[0];
    const enRangeHit = matchAllWithIndices(text, SLOT_EN_RANGE_RE)[0];
    if (rangeHit) {
      const meridiem = (text.match(/下午|上午/) ?? [null])[0];
      const start = toHour(rangeHit.groups[0], meridiem);
      const end = toHour(rangeHit.groups[1], meridiem);
      push(group, id, text, { ...rangeHit.ref, record: id }, 'session-window', 'hard', {
        startHour: start,
        endHour: end
      });
    } else if (enRangeHit) {
      push(group, id, text, { ...enRangeHit.ref, record: id }, 'session-window', 'hard', {
        startHour: Number(enRangeHit.groups[0]),
        endHour: Number(enRangeHit.groups[1])
      });
    } else {
      for (const hit of matchAllWithIndices(text, SLOT_START_RE)) {
        const meridiem = hit.groups[0] ?? (text.match(/下午|上午/) ?? [null])[0];
        const start = toHour(hit.groups[1], meridiem);
        if (start === null) continue;
        push(group, id, text, { ...hit.ref, record: id }, 'session-window', 'hard', {
          startHour: start,
          endHour: null
        });
      }
    }
  }

  const groups = new Map();
  for (const need of all) {
    if (!groups.has(need.group)) groups.set(need.group, []);
    groups.get(need.group).push(need);
  }
  return { groups, all };
}
