// 评估引擎：逐组、逐路段核对硬性需求。
// 规则要点（来自业务约定）：
//   1. 硬性需求无法确认时判 unknown，不能用“无障碍可达”等宣传文案代替确认；
//   2. 被更正回复取代的宣传条件不再采信；
//   3. 条件类原文（雨天停行、须提前安排等）生成必须履行/留意的义务；
//   4. 偏好落空只作提示，不阻断路线；
//   5. 每条结论都挂原句依据，询问时可复现决定所依据的文本。

import { makeRef } from './citations.js';

function activeConditions(segment) {
  return segment.conditions.filter(condition => !condition.supersededBy);
}

function conditionRefs(segment, conditions) {
  return conditions.map(condition =>
    makeRef(condition.record === segment.id ? segment.id : condition.record,
      condition.record === segment.id ? segment.text : condition.quote,
      condition.range[0], condition.range[1]));
}

function confirmationsFor(segment, replies) {
  return replies.filter(reply =>
    reply.kind === 'confirmation' &&
    reply.targets.some(target => target.segmentId === segment.id));
}

/**
 * 评估单个同行组在单个路段上的全部需求。
 * @returns {import('./types.js').SegmentAssessment}
 */
export function assessSegment(group, needs, segment, replies) {
  const findings = [];
  const hardNeeds = needs.filter(need => need.strength === 'hard');
  const softNeeds = needs.filter(need => need.strength === 'soft');
  const conditions = activeConditions(segment);
  const confirmations = confirmationsFor(segment, replies);

  const add = (status, needKind, message, basis) => {
    findings.push({ status, needKind, group, segmentId: segment.id, message, basis });
  };

  for (const need of hardNeeds) {
    switch (need.kind) {
      // 轮椅规模与“存在非折叠轮椅”是同一组事实的两种表述，只在 wheelchair-fleet 评估一次
      case 'wheelchair-fleet':
      case 'non-foldable-wheelchair': {
        if (need.kind === 'non-foldable-wheelchair') break;
        const foldOnly = conditions.find(c => c.kind === 'foldable-only');
        const width = conditions.find(c => c.kind === 'width-dependent');
        const capacity = conditions.find(c => c.kind === 'wheelchair-capacity');
        const fleet = needs.find(n => n.kind === 'wheelchair-fleet');
        const hasNonFoldable =
          (fleet?.attrs.nonFoldableCount ?? 0) > 0 ||
          needs.some(n => n.kind === 'non-foldable-wheelchair');

        if (foldOnly && hasNonFoldable) {
          const imposedBy = foldOnly.attrs.imposedBy
            ? replies.find(reply => reply.id === foldOnly.attrs.imposedBy)
            : null;
          add('blocked', 'wheelchair-fleet',
            '该路段只接可折叠轮椅，团内有不能折叠的轮椅，无法满足。',
            [needRef(fleet ?? need),
            ...(imposedBy ? [replyRef(imposedBy)] : conditionRefs(segment, [foldOnly]))]);
        } else if (width) {
          add('unknown', 'wheelchair-fleet',
            '是否可通过取决于轮椅宽度，资料未给出实际宽度，不能确认。',
            [needRef(fleet ?? need), ...conditionRefs(segment, [width])]);
        } else if (capacity && !hasNonFoldable) {
          add('met', 'wheelchair-fleet', '路段声称可载轮椅，且团内轮椅均可折叠。',
            [needRef(fleet ?? need), ...conditionRefs(segment, [capacity])]);
        } else if (capacity) {
          // 宣传文案声称可载轮椅，但没有更晚的确认回复，且团内有非折叠轮椅
          const confirmed = confirmations.some(reply =>
            /轮椅|wheelchair/i.test(reply.quote));
          if (confirmed) {
            add('met', 'wheelchair-fleet', '接待回复已确认可容纳团内轮椅。',
              [needRef(fleet ?? need), replyRef(confirmations[0])]);
          } else {
            add('unknown', 'wheelchair-fleet',
              '只有笼统的可载轮椅说明，未确认能否容纳不能折叠的轮椅，宣传文案不能代替确认。',
              [needRef(fleet ?? need), ...conditionRefs(segment, [capacity])]);
          }
        } else if (segment.type === '步行' || segment.type === '接驳') {
          // 步行/接驳段对轮椅如何通行只字未提：不能推断可达，返程段同样适用
          add('unknown', 'wheelchair-fleet',
            segment.type === '接驳'
              ? '该接驳段未说明轮椅如何载运，无法确认整组（含轮椅）可乘；不能照搬其他路段的判断。'
              : '步行段未说明轮椅如何通行，无法确认整组（含轮椅）可达。',
            [needRef(fleet ?? need)]);
        }
        break;
      }

      case 'steps-with-rails': {
        const stepConditions = conditions.filter(c => c.kind === 'steps-rails');
        const noSteps = stepConditions.some(c => c.attrs.noSteps);
        const withRails = stepConditions.find(c => c.attrs.hasRails === true);
        const withoutRails = stepConditions.find(c => c.attrs.hasRails === false);
        if (noSteps) {
          add('met', need.kind, '该路段无台阶，扶手需求不适用。',
            [needRef(need), ...conditionRefs(segment, stepConditions)]);
        } else if (withRails) {
          add('met', need.kind, '有台阶且设有扶手，符合硬性需求。',
            [needRef(need), ...conditionRefs(segment, [withRails])]);
        } else if (withoutRails) {
          add('blocked', need.kind, '有台阶但无扶手，不符合硬性需求。',
            [needRef(need), ...conditionRefs(segment, [withoutRails])]);
        } else if (stepConditions.length > 0 && stepConditions.every(c => c.attrs.hasRails === null)) {
          add('unknown', need.kind, '提到台阶但未说明扶手情况，无法确认。',
            [needRef(need), ...conditionRefs(segment, stepConditions)]);
        }
        // 无台阶信息的路段（如接驳）本需求不适用，不产生发现
        break;
      }

      case 'short-walk': {
        const duration = conditions.find(c => c.kind === 'walk-duration');
        if (segment.type !== '步行') break;
        if (duration) {
          add('met', need.kind, `步行用时 ${duration.attrs.minutes} 分钟，属于可接受的短距离。`,
            [needRef(need), ...conditionRefs(segment, [duration])]);
        } else {
          add('unknown', need.kind,
            '步行段未给出距离或用时，短距离步行需求无法确认。',
            [needRef(need)]);
        }
        break;
      }

      case 'session-window': {
        if (segment.type !== '讲解') break;
        const start = need.attrs.startHour;
        const end = need.attrs.endHour;
        const hour = segment.slotMinutes === null ? null : Math.floor(segment.slotMinutes / 60);
        if (hour === null) {
          add('unknown', need.kind, '讲解场次时间无法解析，时段需求无法确认。',
            [needRef(need)]);
        } else if (hour >= start && (end === null || hour < end)) {
          add('met', need.kind, `场次 ${segment.slot} 落在要求的讲解时段内。`,
            [needRef(need)]);
        } else {
          add('blocked', need.kind, `场次 ${segment.slot} 不在要求的讲解时段（${start}点起${end === null ? '' : `至${end}点`}）。`,
            [needRef(need)]);
        }
        break;
      }

      case 'accompany-teacher':
        // 同行约束在路线/分组层面校验，逐路段只记录适用提醒
        add('obligation', need.kind,
          '约定同行的成员必须走同一交通段并参加同一场次，路线不得把该组拆开。',
          [needRef(need)]);
        break;

      default:
        break;
    }
  }

  // 路段自带条件 -> 义务与注意事项
  for (const condition of conditions) {
    if (condition.kind === 'weather-closure') {
      findings.push({
        status: 'obligation', needKind: 'weather-closure', group, segmentId: segment.id,
        message: '该路段雨天停行，承诺时须注明“除雨天外”，并准备雨天替代安排。',
        basis: conditionRefs(segment, [condition])
      });
    }
    if (condition.kind === 'advance-arrangement') {
      findings.push({
        status: 'obligation', needKind: 'advance-arrangement', group, segmentId: segment.id,
        message: '该活动须提前安排，承诺前必须完成预约并留痕。',
        basis: conditionRefs(segment, [condition])
      });
    }
    if (condition.kind === 'whole-group-reception') {
      findings.push({
        status: 'obligation', needKind: 'whole-group-reception', group, segmentId: segment.id,
        message: '场馆支持整团/同场接待，但仍受提前安排等条件约束。',
        basis: conditionRefs(segment, [condition])
      });
    }
  }

  // 确认回复：把场次席位/开放时间等接待条件标为已确认
  for (const reply of confirmations) {
    findings.push({
      status: 'met', needKind: 'reception-confirmation', group, segmentId: segment.id,
      message: `接待回复（${reply.received} 收到）确认本场次安排：${reply.quote}`,
      basis: [replyRef(reply)]
    });
  }

  // 偏好检查（不阻断）
  for (const need of softNeeds) {
    if (need.kind === 'lift-preference') {
      const hasLift = /电梯|升降机|lift|elevator/i.test(segment.text);
      if (!hasLift) {
        findings.push({
          status: 'preference-lost', needKind: need.kind, group, segmentId: segment.id,
          message: '家长对电梯的偏好在本路段无法满足；有扶手台阶可作为替代，偏好可舍弃但须说明。',
          basis: [needRef(need)]
        });
      }
    }
  }

  // 汇总路段状态
  let status = 'confirmed';
  for (const finding of findings) {
    if (finding.status === 'blocked') { status = 'blocked'; break; }
    if (finding.status === 'unknown' && status !== 'blocked') status = 'uncertain';
  }
  return {
    segmentId: segment.id,
    group,
    status,
    findings,
    confirmedBy: confirmations.map(reply => reply.id)
  };
}

/** 评估某组在所有路段上的情况。 */
export function assessGroup(group, needs, segments, replies) {
  return segments.map(segment => assessSegment(group, needs, segment, replies));
}

function needRef(need) {
  return { record: need.record, quote: need.quote, range: need.range };
}

function replyRef(reply) {
  return { record: reply.id, quote: reply.quote, range: reply.ref.range };
}
