// 解析场馆/接驳方的接待回复（接待回复.json）。
// 回复分两类：
//   confirmation：确认某个场次/接待条件仍有效；
//   correction：对早前宣传文案的更正（如“小巴可载轮椅”仅指可折叠型）。
// 更正不能与宣传文案并列采信，必须以较晚录入的回复为准，并保留原句。

import { makeRef, matchAllWithIndices } from './citations.js';
import { toMinutes } from './segments.js';

const TIME_RE = /([零一二两三四五六七八九十\d]+)点([零一二两三四五六七八九十\d]+)?/gd;
const CORRECTION_RE = /仅指|无法载|澄清|更正|改为|只限|only refers|cannot carry|clarif/gdi;
const CONFIRM_RE = /仍有席位|可两组同听|已核实|开放时间已核实|等到|仍有效|confirmed|still available|verified/gdi;

const CN_NUM = { 零: 0, 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

function cnToNumber(token) {
  if (!token) return null;
  if (/^\d+$/.test(token)) return Number(token);
  if (token.length === 1) return CN_NUM[token] ?? null;
  if (token === '十') return 10;
  if (token.startsWith('十')) return 10 + (CN_NUM[token[1]] ?? 0);
  if (token.endsWith('十')) return (CN_NUM[token[0]] ?? 0) * 10;
  const tenIdx = token.indexOf('十');
  if (tenIdx > 0) return (CN_NUM[token[0]] ?? 0) * 10 + (CN_NUM[token[tenIdx + 1]] ?? 0);
  return null;
}

/** 把回复中的中文时间（如“十四点二十”“十三点二十五”）转为分钟数。 */
export function replyTimeToMinutes(text) {
  const hits = [...text.matchAll(TIME_RE)];
  if (hits.length === 0) return null;
  const groups = hits[0];
  const hour = cnToNumber(groups[1]);
  const minute = cnToNumber(groups[2]) ?? 0;
  if (hour === null) return null;
  return hour * 60 + minute;
}

/**
 * @param {Array<{id:string,source:string,received:string,text:string}>} rows
 * @param {Map<string, import('./types.js').Segment>} segmentById
 * @returns {Array<import('./types.js').ReplyEffect>}
 */
export function parseReplies(rows, segmentById) {
  return rows.map(row => {
    const isCorrection = matchAllWithIndices(row.text, CORRECTION_RE).length > 0;
    const isConfirmation = matchAllWithIndices(row.text, CONFIRM_RE).length > 0;
    const mentionedMinutes = replyTimeToMinutes(row.text);

    // 回复关联到路段，三条线索：
    //   1) source 名称与路段的“接待地点”（讲解段看 to，其余看起讫点）相符；
    //   2) 回复内提到的时间与路段场次相同；
    //   3) 回复正文提到路段原句中的关键词（如“小巴”对应接驳段）。
    const targets = [];
    for (const segment of segmentById.values()) {
      // 接待地点匹配：
      //   讲解段的接待地点是 to，要求与 source 完全相同；
      //   接驳段只在 source 就是其起点单位时才算，场馆名称命中其终点不算接待确认。
      const sourceHits = Boolean(row.source) &&
        (segment.type === '讲解'
          ? segment.to === row.source
          : segment.from === row.source);
      const timeHits = mentionedMinutes !== null && segment.slotMinutes === mentionedMinutes;
      // 接驳类回复按车辆关键词命中；若回复明确限定“去程/返程”方向，
      // 则只配同方向的路段，避免把去程澄清错误套到返程。
      const mentionsVehicle = /小巴|巴士|shuttle|minibus/i.test(row.text) &&
        !/讲解|展厅|讲师|席位|session|lecturer/i.test(row.text);
      const replyIsOutbound = /去程|outbound/i.test(row.text);
      const replyIsReturn = /返程|回程|return/i.test(row.text);
      const segmentIsReturn = /返程|回程|return/i.test(segment.text);
      const directionOk = (!replyIsOutbound && !replyIsReturn) ||
        (replyIsOutbound && !segmentIsReturn) ||
        (replyIsReturn && segmentIsReturn);
      const textHits = segment.type === '接驳' && mentionsVehicle && directionOk;
      if (sourceHits || timeHits || textHits) {
        targets.push({
          segmentId: segment.id,
          matchedBy: [
            ...(sourceHits ? ['source'] : []),
            ...(timeHits ? ['time'] : []),
            ...(textHits ? ['text'] : [])
          ]
        });
      }
    }

    return {
      id: row.id,
      source: row.source,
      received: row.received,
      receivedMinutes: toMinutes(row.received),
      kind: isCorrection ? 'correction' : isConfirmation ? 'confirmation' : 'other',
      quote: row.text,
      ref: makeRef(row.id, row.text, 0, row.text.length),
      mentionedMinutes,
      targets
    };
  });
}

/**
 * 应用更正：被更正的路段条件会被标记 superseded，并挂上更正回复引用。
 * 宣传文案不能再作为该条件的确认依据。
 * @param {import('./types.js').Segment[]} segments
 * @param {import('./types.js').ReplyEffect[]} replies
 */
export function applyCorrections(segments, replies) {
  const corrections = replies.filter(reply => reply.kind === 'correction');
  for (const correction of corrections) {
    for (const target of correction.targets) {
      const segment = segments.find(item => item.id === target.segmentId);
      if (!segment) continue;
      for (const condition of segment.conditions) {
        if (condition.kind === 'wheelchair-capacity' || condition.kind === 'foldable-only') {
          condition.supersededBy = correction.id;
        }
      }
      // 更正后的有效条件：只限可折叠轮椅
      segment.conditions.push({
        kind: 'foldable-only',
        record: segment.id,
        quote: correction.quote,
        range: [0, correction.quote.length],
        attrs: { foldableOnly: true, imposedBy: correction.id }
      });
    }
  }
}
