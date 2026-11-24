import { getGroupProfile } from './analysis.js';
import { planItineraries } from './planner.js';

function sourceLine(source) {
  if (!source) return '';
  const head = [source.id, source.source ? `（${source.source}${source.received ? `，${source.received}` : ''}）` : ''].join('');
  return `${head}：${source.text}`;
}

export function buildGuideBrief(analysis, ledger, groupName, options = {}) {
  // Allow buildGuideBrief(analysis, groupName, options).
  if (typeof ledger === 'string') {
    options = groupName || {};
    groupName = ledger;
    ledger = null;
  } else if (ledger && !('bookings' in ledger) && !groupName) {
    options = ledger;
    ledger = null;
  }

  const profile = getGroupProfile(analysis, groupName);
  const group = profile?.group || groupName || '全部团组';
  const plan = planItineraries(analysis, { ...options, group: profile?.group || groupName });
  const bookings = ledger
    ? ledger.listForGroup(profile?.group || groupName, { tourId: options.tourId })
    : [];

  const instructions = [];
  for (const p of plan.plans) {
    for (const assessment of p.segments) {
      const segment = analysis.byId[assessment.segmentId];
      instructions.push({
        planId: p.id,
        time: segment?.slot || null,
        segmentId: assessment.segmentId,
        type: assessment.type,
        route: segment ? `${segment.from} → ${segment.to}` : null,
        status: assessment.status,
        instruction: instructionFor(assessment),
        issues: assessment.issues.map(i => ({ code: i.code, message: i.message, segmentId: i.segmentId })),
        quotes: collectQuotes(analysis, assessment)
      });
    }
  }

  const pending = plan.plans.flatMap(p => p.issues.filter(i => i.severity !== 'info').map(i => ({
    planId: p.id,
    code: i.code,
    segmentId: i.segmentId,
    message: i.message,
    evidence: i.evidence || []
  })));

  const sources = [
    ...analysis.requirements.filter(r => !profile || profile.requirementIds.includes(r.id)),
    ...analysis.resources,
    ...analysis.replies
  ].map(r => ({ id: r.id, source: r.source, group: r.group, received: r.received, text: r.text }));

  const locators = collectLocators(analysis, profile);

  const brief = {
    title: `导游当前说明：${group}`,
    group,
    tourId: options.tourId || 'current-tour',
    generatedAt: options.now || new Date().toISOString(),
    hardRequirements: profile?.hardRequirements || [],
    wheelchairs: profile?.wheelchairs || null,
    companionGroups: profile?.companionGroups || [],
    plans: plan.plans.map(p => ({
      id: p.id,
      status: p.status,
      committable: p.committable,
      resourceIds: p.resourceIds,
      sessionIds: p.sessionIds,
      issues: p.issues.map(i => ({
        code: i.code,
        severity: i.severity,
        message: i.message,
        segmentId: i.segmentId,
        evidence: (i.evidence || []).map(ev => ({ locator: ev.locator, quote: ev.quote, sentence: ev.sentence })).filter(Boolean)
      })),
      adjustments: p.adjustments,
      sacrificedPreferences: p.sacrificedPreferences
    })),
    instructions,
    pendingConfirmations: pending,
    bookings: bookings.map(b => ({
      id: b.id,
      tourId: b.tourId,
      status: b.status,
      segmentIds: b.segmentIds,
      sessionIds: b.sessionIds,
      staleItems: b.staleItems,
      validArrangements: b.basis?.filter(x => !(b.staleItems || []).includes(x.segmentId)).map(x => x.segmentId) || []
    })),
    confirmationPolicy: '接待/预约确认只适用于记录中的团次、人群、路段和场次；新团必须重新确认，不能复用旧预约确认。',
    sources,
    locators,
    reproducibleTexts: sources.map(sourceLine)
  };
  brief.markdown = renderBriefMarkdown(brief, analysis);
  brief.text = brief.markdown;
  return brief;
}

function instructionFor(assessment) {
  if (assessment.status === 'committable') return '现有具体说明与接待确认支持此段，可按当前安排带团。';
  if (assessment.status === 'unavailable') return '已有明确信息显示此段不能满足该团硬性需求，不得承诺；请改用替代方案。';
  return '此段尚有待确认事项；在取得具体确认前，只能作为方案，不能向家长承诺。';
}

function collectQuotes(analysis, assessment) {
  const ids = new Set();
  const quotes = [];
  for (const ev of assessment.evidence || []) {
    if (ev?.locator && !ids.has(ev.locator)) {
      ids.add(ev.locator);
      quotes.push({ locator: ev.locator, quote: ev.quote, sentence: ev.sentence });
    }
  }
  for (const issue of assessment.issues || []) {
    for (const ev of issue.evidence || []) {
      if (ev?.locator && !ids.has(ev.locator)) {
        ids.add(ev.locator);
        quotes.push({ locator: ev.locator, quote: ev.quote, sentence: ev.sentence });
      }
    }
  }
  return quotes;
}

function collectLocators(analysis, profile) {
  const out = [];
  const seen = new Set();
  const push = ev => {
    if (ev?.locator && !seen.has(ev.locator)) {
      seen.add(ev.locator);
      out.push({ locator: ev.locator, quote: ev.quote, sentence: ev.sentence || ev.quote });
    }
  };
  const rows = [
    ...analysis.requirements.filter(r => !profile || profile.requirementIds.includes(r.id)),
    ...analysis.resources,
    ...analysis.replies
  ];
  for (const row of rows) {
    (row.evidence || []).forEach(push);
    for (const c of row.constraints || []) {
      const evidenceList = Array.isArray(c.evidence) ? c.evidence : [c.evidence];
      evidenceList.forEach(push);
      push(c.stepsEvidence);
      push(c.railsEvidence);
    }
    for (const c of row.claims || []) push(c.evidence);
    for (const rel of row.relations || []) push(rel.evidence);
    for (const cond of row.conditions || []) push(cond.evidence);
  }
  return out;
}

export function renderBriefMarkdown(brief, analysis = null) {
  const lines = [];
  lines.push(`# ${brief.title}`);
  lines.push('');
  if (brief.wheelchairs) {
    lines.push(`- 轮椅：共 ${brief.wheelchairs.total} 部；可折叠 ${brief.wheelchairs.foldable ?? '未说明'} 部；不可折叠 ${brief.wheelchairs.nonFoldable ?? '未说明'} 部。`);
  }
  if (brief.companionGroups?.length) {
    lines.push(`- 必须同行：${brief.companionGroups.map(g => g.join(' ↔ ')).join('；')}。同行者必须走同一交通段、参加同一场次。`);
  }
  lines.push(`- 确认使用范围：${brief.confirmationPolicy}`);
  lines.push('');

  lines.push('## 方案状态');
  for (const p of brief.plans) {
    lines.push(`### ${p.id} — ${statusLabel(p.status)}`);
    lines.push(`路段/场次：${p.resourceIds.join(' → ')}`);
    if (!p.issues.length) lines.push('- 未发现未决硬性冲突。');
    for (const i of p.issues) lines.push(`- [${severityLabel(i.severity)}] ${i.message}`);
    for (const a of p.adjustments) lines.push(`- 调整建议（${a.code}）：${a.message}`);
    for (const s of p.sacrificedPreferences) lines.push(`- 舍弃偏好：${s.message}`);
    lines.push('');
  }

  if (brief.bookings.length) {
    lines.push('## 当前团次预订单');
    for (const b of brief.bookings) {
      lines.push(`- ${b.id}：${b.status}；路段 ${b.segmentIds.join('、')}`);
      if (b.staleItems?.length) lines.push(`  - 须重新确认：${b.staleItems.join('、')}`);
      if (b.validArrangements?.length) lines.push(`  - 仍有效：${b.validArrangements.join('、')}`);
    }
    lines.push('');
  }

  lines.push('## 决定所依据的原文');
  for (const s of brief.sources) lines.push(`- ${sourceLine(s)}`);
  lines.push('');
  lines.push('## 可复现定位');
  const renderedLocators = new Set();
  for (const p of brief.plans) {
    for (const issue of p.issues) {
      for (const ev of issue.evidence || []) {
        if (ev.locator && !renderedLocators.has(ev.locator)) {
          renderedLocators.add(ev.locator);
          lines.push(`- ${ev.locator}：${ev.sentence || ev.quote}`);
        }
      }
    }
  }
  for (const ev of brief.locators || []) {
    if (!renderedLocators.has(ev.locator)) {
      renderedLocators.add(ev.locator);
      lines.push(`- ${ev.locator}：${ev.sentence || ev.quote}`);
    }
  }
  return lines.join('\n');
}

function statusLabel(status) {
  return { committable: '可承诺', needs_confirmation: '待确认', unavailable: '不可承诺/不适用' }[status] || status;
}
function severityLabel(sev) {
  return { blocker: '阻断', uncertain: '无法确认', condition: '条件待落实', preference: '偏好' }[sev] || sev;
}

export const guideBrief = buildGuideBrief;

export function answerGuideQuestion(analysis, groupName, question = '', options = {}) {
  const brief = buildGuideBrief(analysis, null, groupName, options);
  const q = String(question).toLowerCase();
  const ids = q.match(/[svr]\d+/gi) || [];
  const terms = q.split(/[\s,，。?？!！:：、]+/u).filter(t => t.length >= 2);
  const matchesText = text => {
    const lower = String(text || '').toLowerCase();
    return ids.some(id => lower.includes(id.toLowerCase()))
      || terms.some(term => lower.includes(term));
  };

  const sources = brief.sources.filter(s => ids.includes(s.id) || matchesText(`${s.source || ''} ${s.text}`));
  const evidence = brief.locators.filter(e => matchesText(`${e.locator} ${e.quote} ${e.sentence}`));
  const issues = brief.plans.flatMap(p => p.issues
    .filter(i => ids.includes(i.segmentId) || matchesText(`${i.code} ${i.message}`))
    .map(i => ({ ...i, planId: p.id })));

  const lines = [`# 依据检索：${brief.group}`, `问题：${question}`, ''];
  if (issues.length) {
    lines.push('## 相关判断');
    for (const i of issues) lines.push(`- [${i.planId}] ${i.message}`);
  }
  lines.push('## 可复现原文');
  const chosenSources = sources.length ? sources : brief.sources;
  for (const s of chosenSources) lines.push(`- ${sourceLine(s)}`);
  if (evidence.length) {
    lines.push('## 文本范围');
    for (const e of evidence) lines.push(`- ${e.locator}：${e.sentence || e.quote}`);
  }
  return { question, group: brief.group, sources, evidence, issues, markdown: lines.join('\n') };
}

export const answerQuestion = answerGuideQuestion;

export function explainToParents(analysis, groupName, options = {}) {
  if (typeof groupName === 'object') {
    options = groupName;
    groupName = options.group;
  }
  const result = planItineraries(analysis, { ...options, group: groupName });
  const canPromise = result.committablePlans;
  const pending = result.pendingPlans;
  const unavailable = result.unavailablePlans;
  const lines = [];
  lines.push(`# 致家长的行程说明：${result.group || groupName}`);
  lines.push('');
  if (canPromise.length) {
    lines.push('以下安排已有具体路段和场馆确认，可以承诺：');
    for (const p of canPromise) lines.push(`- ${p.resourceIds.join(' → ')}`);
  } else {
    lines.push('目前没有一条路线能在不补充确认的情况下作完整无障碍承诺。');
  }
  if (pending.length) {
    lines.push('');
    lines.push('这些方案方向可行，但以下段落尚不能确认：');
    for (const p of pending) {
      lines.push(`- 方案 ${p.resourceIds.join(' → ')}`);
      for (const i of p.issues) lines.push(`  - ${parentFriendlyIssue(i)}`);
      for (const a of p.adjustments) lines.push(`  - 可调整：${a.message}`);
      for (const s of p.sacrificedPreferences) lines.push(`  - 偏好取舍：${s.message}`);
    }
  }
  if (unavailable.length) {
    lines.push('');
    lines.push('以下安排按当前资料不可行：');
    for (const p of unavailable) for (const i of p.issues.filter(x => x.severity === 'blocker')) lines.push(`- ${parentFriendlyIssue(i)}`);
  }
  lines.push('');
  lines.push('我们不会以“无障碍可达”这类笼统宣传代替路段、接驳和场次的具体确认。');
  return {
    group: result.group,
    canPromise,
    pending,
    unavailable,
    markdown: lines.join('\n'),
    text: lines.join('\n')
  };
}

function parentFriendlyIssue(issue) {
  const map = {
    wheelchair_step_access_unconfirmed: '台阶和扶手适合短距离步行，但还不能确认轮椅如何通过这一段。',
    weather_condition_unconfirmed: '该段在雨天会停行；需要确认天气或雨天替代路线。',
    non_foldable_wheelchair_denied: '接驳车辆已澄清不能载运那部不可折叠的轮椅。',
    time_conflict: '相邻路段的时间接不上，不能按这个组合安排。',
    generic_accessibility_unverified: '“无障碍/accessible”的笼统说法不足以确认实际使用条件。',
    wheelchair_width_unconfirmed: '接驳或入口是否适用，取决于本团轮椅的实际宽度。'
  };
  return map[issue.code] || issue.message;
}

