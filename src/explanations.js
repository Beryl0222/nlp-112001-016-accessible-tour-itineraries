// 解释模块：把评估结果转成可向家长/导游说明的文字。
// 硬性要求：原文（含粤语书面词与英文）必须原样引用，不翻译、不改写；
// 不确定的段落要明确说“尚不确定”，不能用宣传文案代替确认。

import { uniqueRefs } from './citations.js';

function formatBasis(findings) {
  const refs = uniqueRefs(findings.flatMap(f => f.basis));
  return refs.map(ref => `${ref.record}「${ref.quote}」`).join('；');
}

/**
 * 面向家长的说明：需要调整之处、可提供的方案、舍弃了哪些偏好。
 * @param {string} group
 * @param {Array<object>} routeEvaluations evaluateRoutesForGroup 的输出
 */
export function explainForParent(group, routeEvaluations) {
  const lines = [`【${group} 家长说明】`];
  let optionIndex = 0;

  for (const evaluation of routeEvaluations) {
    optionIndex += 1;
    const head = `方案 ${optionIndex}：${evaluation.labels.join(' → ')}`;
    lines.push(head);

    if (!evaluation.connected) {
      const broken = evaluation.connectivity.filter(step => !step.ok);
      lines.push(`· 路线不能成立：${broken.map(step => step.reason).join('；')}`);
      lines.push('· 处理：改用其他入口或交通段，且替代段必须连得上后续讲解。');
      continue;
    }

    if (evaluation.blockedSegments.length > 0) {
      lines.push(`· 无法承诺的路段：${evaluation.blockedSegments.join('、')}`);
      for (const assessment of evaluation.assessments) {
        for (const finding of assessment.findings.filter(f => f.status === 'blocked')) {
          lines.push(`  - ${finding.message}`);
          lines.push(`    依据：${formatBasis([finding])}`);
        }
      }
      lines.push('· 可调整方向：更换可容纳该轮椅的接驳，或把不能折叠的轮椅换为可折叠型（需团方同意）。');
    }

    if (evaluation.uncertainSegments.length > 0) {
      lines.push(`· 尚不确定、承诺前必须再确认的路段：${evaluation.uncertainSegments.join('、')}`);
      for (const assessment of evaluation.assessments) {
        for (const finding of assessment.findings.filter(f => f.status === 'unknown')) {
          lines.push(`  - ${finding.message}`);
          lines.push(`    依据原文：${formatBasis([finding])}`);
        }
      }
      lines.push('· 在收到针对该路段的明确接待回复前，本方案只能列为待定，不能按“无障碍可达”宣传直接承诺。');
    }

    for (const obligation of evaluation.obligations) {
      lines.push(`· 需配合的安排（${obligation.segmentId}）：${obligation.message}`);
      lines.push(`  原文：${obligation.basis.map(b => `${b.record}「${b.quote}」`).join('；')}`);
    }

    for (const lost of evaluation.lostPreferences) {
      lines.push(`· 舍弃的偏好（${lost.segmentId}）：${lost.message}`);
      lines.push(`  偏好原句：${lost.basis.map(b => `${b.record}「${b.quote}」`).join('；')}`);
    }

    if (evaluation.committable) {
      lines.push('· 本方案各硬性需求均有原文依据且接待条件已确认，可以承诺。');
    }
    lines.push('');
  }

  return lines.join('\n');
}

/**
 * 面向导游的按团说明：当前有效/待确认条目与决定依据，询问时可复现原文。
 * @param {import('./ledger.js').TourLedger} ledger
 * @param {string} tourId
 */
export function briefingForGuide(ledger, tourId) {
  const entries = ledger.briefingFor(tourId);
  if (entries.length === 0) {
    return `团号 ${tourId} 暂无任何已登记确认；新团不能复用其他团的旧确认。`;
  }
  const lines = [`【导游说明｜团号 ${tourId}】`];
  for (const entry of entries) {
    const stateText = entry.state === 'confirmed' ? '仍有效'
      : entry.state === 'reconfirm-required' ? '需重新确认' : '已作废';
    lines.push(`· ${entry.group} / ${entry.segmentId}：${stateText}`);
    lines.push(`  原判断依据：${entry.originalBasis || '（登记时无逐条依据）'}`);
    if (entry.supersededBy) lines.push(`  失效/待确认来源：${entry.supersededBy}`);
    if (entry.note) lines.push(`  备注：${entry.note}`);
  }
  return lines.join('\n');
}

/**
 * 接单人员视图：只列真正受影响的路线和场次。
 * @param {Array<object>} routeEvaluations
 * @param {string[]} affectedSegmentIds
 */
export function affectedOnly(routeEvaluations, affectedSegmentIds) {
  const out = [];
  for (const evaluation of routeEvaluations) {
    const hit = evaluation.segmentIds.filter(id => affectedSegmentIds.includes(id));
    if (hit.length === 0) continue;
    out.push({
      route: evaluation.segmentIds,
      affectedSegments: hit,
      blocked: evaluation.blockedSegments.filter(id => affectedSegmentIds.includes(id)),
      uncertain: evaluation.uncertainSegments.filter(id => affectedSegmentIds.includes(id))
    });
  }
  return out;
}
