// 确认台账：按团保存已确认行程，记录判断依据、仍有效安排与需重新确认的段落。
// 业务规则：
//   1. 接驳方等单位后来澄清/更正时，旧判断依据作废，受影响段落与路线必须标出；
//   2. 同团只有部分成员改变同行约定时，旧计划中必须一同重约的部分级联失效；
//   3. 团方可缩小需求或接受替代路线，缩窄后只重新评估真正受影响的路段/场次；
//   4. 新团不能复用旧确认：每个团独立台账，确认与团号绑定。

import { assessSegment } from './assessment.js';

let sequence = 0;

/**
 * @typedef {Object} ConfirmationEntry
 * @property {string} tourId
 * @property {string} group
 * @property {string} segmentId
 * @property {'confirmed'|'reconfirm-required'|'superseded'} state
 * @property {string[]} basisRefs 原判断依据（记录编号）
 * @property {string} originalBasis 原判断的文字摘要（含原句）
 * @property {string|null} supersededBy 使其失效的回复/变更编号
 * @property {string} note
 */

export class TourLedger {
  constructor() {
    /** @type {Map<string, Map<string, ConfirmationEntry>>} tourId -> key -> entry */
    this.tours = new Map();
  }

  static createTourId(prefix = 'tour') {
    sequence += 1;
    const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    return `${prefix}-${stamp}-${sequence}`;
  }

  /**
   * 为一个团登记确认。新团（新 tourId）自动得到空台账，无法读到其他团的确认。
   */
  recordConfirmation(tourId, group, segmentId, assessment, note = '') {
    if (!this.tours.has(tourId)) this.tours.set(tourId, new Map());
    const table = this.tours.get(tourId);
    const key = `${group}/${segmentId}`;
    const basisRefs = [...new Set(assessment.findings.flatMap(f => f.basis.map(b => b.record)))];
    const originalBasis = assessment.findings
      .filter(f => f.status === 'met' || f.status === 'obligation')
      .map(f => `[${f.basis.map(b => `${b.record}「${b.quote}」`).join('；')}] ${f.message}`)
      .join('\n');
    table.set(key, {
      tourId, group, segmentId,
      state: assessment.status === 'confirmed' ? 'confirmed' : 'reconfirm-required',
      basisRefs,
      originalBasis: originalBasis || '该组在本路段没有适用的硬性需求；路段状态仅按通用接待条件登记，不构成无障碍确认。',
      supersededBy: null,
      note
    });
    return table.get(key);
  }

  /** 读取某团的全部确认；查不到该团时返回空，绝不回落到其他团的数据。 */
  forTour(tourId) {
    const table = this.tours.get(tourId);
    return table ? [...table.values()] : [];
  }

  /**
   * 外部更正（如 v2 澄清“小巴可载轮椅”只指可折叠型）：
   * 只把真正受影响的段落标为需重新确认，并记录原判断依据与仍有效安排。
   * @returns {ConfirmationEntry[]} 受影响的条目
   */
  applyExternalCorrection(tourId, reply, affectedSegmentIds, stillValidSegmentIds = []) {
    const table = this.tours.get(tourId);
    if (!table) throw new Error(`台账中没有团号 ${tourId}，新团不能复用旧确认`);
    const affected = [];
    for (const entry of table.values()) {
      if (affectedSegmentIds.includes(entry.segmentId) && entry.state !== 'superseded') {
        entry.state = 'reconfirm-required';
        entry.supersededBy = reply.id;
        entry.note = `依据回复 ${reply.id}「${reply.quote}」，原判断需重新确认；${
          stillValidSegmentIds.length > 0 ? `仍有效安排：${stillValidSegmentIds.join('、')}` : '无仍有效安排'}`;
        affected.push(entry);
      }
    }
    return affected;
  }

  /**
   * 同团部分成员改变同行约定：旧计划中与变更成员绑定、必须一同重约的部分级联失效。
   * @param {string[]} jointSegmentIds 旧计划里必须一同重约的交通段/场次
   */
  cascadeCompanionChange(tourId, changeRef, jointSegmentIds) {
    const table = this.tours.get(tourId);
    if (!table) throw new Error(`台账中没有团号 ${tourId}`);
    const invalidated = [];
    for (const entry of table.values()) {
      if (jointSegmentIds.includes(entry.segmentId)) {
        entry.state = 'reconfirm-required';
        entry.supersededBy = changeRef;
        entry.note = `同行约定变更（${changeRef}）：该段与变更成员在旧计划中绑定，必须一同重约。`;
        invalidated.push(entry);
      }
    }
    return invalidated;
  }

  /**
   * 团方缩小需求或接受替代路线后，只重新评估受影响路段，其余确认保持有效。
   * @returns {{ reconfirmed: ConfirmationEntry[], untouched: ConfirmationEntry[] }}
   */
  narrowAndReassess(tourId, group, newNeeds, segments, replies, affectedSegmentIds) {
    const table = this.tours.get(tourId);
    if (!table) throw new Error(`台账中没有团号 ${tourId}`);
    const reconfirmed = [];
    const untouched = [];
    for (const entry of table.values()) {
      if (entry.group !== group || !affectedSegmentIds.includes(entry.segmentId)) {
        untouched.push(entry);
        continue;
      }
      const segment = segments.find(item => item.id === entry.segmentId);
      const assessment = assessSegment(group, newNeeds, segment, replies);
      const refreshed = this.recordConfirmation(tourId, group, entry.segmentId, assessment,
        '团方缩小需求/接受替代路线后重新评估');
      refreshed.basisRefs = [...new Set([...entry.basisRefs, ...refreshed.basisRefs])];
      reconfirmed.push(refreshed);
    }
    return { reconfirmed, untouched };
  }

  /** 导游按团领取当前说明：只列出该团、且当前仍有效或待确认的条目。 */
  briefingFor(tourId) {
    return this.forTour(tourId).filter(entry => entry.state !== 'superseded');
  }

  /** 复现某条决定所依据的文本（原判断依据 + 使其失效的回复原句）。 */
  traceDecision(tourId, group, segmentId) {
    const table = this.tours.get(tourId);
    const entry = table?.get(`${group}/${segmentId}`);
    if (!entry) return null;
    return {
      state: entry.state,
      originalBasis: entry.originalBasis,
      supersededBy: entry.supersededBy,
      note: entry.note
    };
  }
}
