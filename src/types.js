// 共享类型定义（仅 JSDoc，无运行时代码）。

/**
 * @typedef {Object} Segment 路段或活动
 * @property {string} id
 * @property {string} type 步行 | 接驳 | 讲解
 * @property {string} from
 * @property {string} to
 * @property {string} slot
 * @property {number|null} slotMinutes
 * @property {string} text
 * @property {Array<Condition>} conditions
 *
 * @typedef {Object} Condition
 * @property {string} kind
 * @property {string} record
 * @property {string} quote
 * @property {[number, number]} range
 * @property {Record<string, unknown>} attrs
 * @property {string} [supersededBy]
 *
 * @typedef {Object} ReplyEffect
 * @property {string} id
 * @property {string} source
 * @property {string} received
 * @property {number|null} receivedMinutes
 * @property {'correction'|'confirmation'|'other'} kind
 * @property {string} quote
 * @property {{record:string, quote:string, range:[number,number]}} ref
 * @property {number|null} mentionedMinutes
 * @property {Array<{segmentId:string, matchedBy:string[]}>} targets
 *
 * @typedef {Object} Finding 针对“某组需求 × 某路段”的一条评估发现
 * @property {'met'|'blocked'|'unknown'|'obligation'|'preference-lost'} status
 * @property {string} needKind
 * @property {string} group
 * @property {string} segmentId
 * @property {string} message 结论说明（可含原文引用占位）
 * @property {Array<{record:string, quote:string, range?:[number,number]}>} basis 依据原文
 *
 * @typedef {Object} SegmentAssessment
 * @property {string} segmentId
 * @property {string} group
 * @property {'confirmed'|'uncertain'|'blocked'} status
 * @property {Finding[]} findings
 * @property {Array<string>} confirmedBy 确认该段的回复编号
 */
