import {
  allEvidenceForMatch,
  evidenceForMatch,
  parseDurationMinutes,
  parseTimeWindow
} from './text-utils.js';

const PERSON_PATTERNS = [
  ['children', /小朋友|孩子|孩童|学童|學童|學生|学生|children?|kids?|pupils?/iu],
  ['leadTeacher', /带队老师|帶隊老師|领队老师|領隊老師|老师|老師|带队|帶隊|teacher|escort|group leader/iu],
  ['parent', /家长|家長|父母|parent|guardian/iu],
  ['wheelchairUser', /輪椅使用者|轮椅使用者|殘疾?人士|残疾?人士|wheelchair user/iu]
];

function peopleInSentence(sentence) {
  const people = [];
  for (const [id, re] of PERSON_PATTERNS) {
    if (re.test(sentence)) people.push(id);
  }
  return people;
}

function countWord(value) {
  if (value == null) return null;
  if (/^\d+$/.test(value)) return Number(value);
  const map = { one: 1, two: 2, three: 3, four: 4, five: 5, 一: 1, 二: 2, 两: 2, 兩: 2, 三: 3, 四: 4, 五: 5 };
  return map[String(value).toLowerCase()] ?? null;
}

function baseInterpretation(row, kind) {
  return {
    id: row.id,
    kind,
    source: row.source,
    received: row.received,
    group: row.group,
    locale: row.locale,
    from: row.from,
    to: row.to,
    slot: row.slot,
    type: row.type,
    text: row.text,
    tags: [],
    conditions: [],
    constraints: [],
    claims: [],
    relations: [],
    evidence: []
  };
}

function addCondition(out, row, code, patterns, extra = {}) {
  for (const pattern of patterns) {
    const ev = evidenceForMatch(row, pattern, { extra: { condition: code } });
    if (ev) {
      const condition = { code, ...extra, evidence: ev };
      out.conditions.push(condition);
      out.evidence.push(ev);
      if (!out.tags.includes(code)) out.tags.push(code);
      return condition;
    }
  }
  return null;
}

function detectCommonConditions(out, row) {
  addCondition(out, row, 'weather_rain', [
    /除雨天外|除了雨天|雨天停行|雨天暫停|雨天暂停|下雨[^。；;]{0,8}(?:停|暫停|暂停)|天雨[^。；;]{0,8}(?:取消|停)/iu,
    /except\s+(?:when\s+|in\s+|on\s+)?(?:it\s+)?rains?|rainy\s+day|in\s+(?:wet|rainy)\s+weather|weather\s+permitting/iu
  ], { affects: 'operation', status: 'conditional' });

  addCondition(out, row, 'advance_arrangement', [
    /須提前安排|须提前安排|需提前安排|須預先安排|须预先安排|提前安排|提早安排|提前預約|提前预约|預先預約|预先预约/iu,
    /advance\s+arrangement|prior\s+arrangement|book(?:ing)?\s+in\s+advance|reserve\s+in\s+advance|subject\s+to\s+(?:prior\s+)?booking/iu
  ], { affects: 'booking', status: 'action_required' });

  addCondition(out, row, 'wheelchair_width', [
    /視輪椅寬度而定|视轮椅宽度而定|取決於輪椅寬度|取决于轮椅宽度|要看輪椅寬度|要看轮椅宽度|輪椅寬度/iu,
    /depending\s+on\s+(?:the\s+)?wheelchair\s+width|subject\s+to\s+wheelchair\s+width|wheelchair\s+width/iu
  ], { affects: 'wheelchair', status: 'needs_measurement' });
}

function detectGenericAccessibility(out, row) {
  const ev = evidenceForMatch(row, /無障礙可達|无障碍可达|無障礙通達|无障碍通达|無障礙|无障碍|barrier[-\s]?free|accessible|accessibility/iu);
  if (ev) {
    const claim = {
      code: 'generic_accessibility_marketing',
      status: 'unsupported',
      specificity: 'generic',
      evidence: ev,
      warning: '笼统无障碍宣传不能替代具体路段、厅堂、接驳和接待确认。'
    };
    out.claims.push(claim);
    out.evidence.push(ev);
    out.tags.push('generic_accessibility');
  }
}

function interpretWheelchairRequirement(out, row) {
  const totalPatterns = [
    /([0-9]+|[一二兩两])\s*部\s*輪椅/iu,
    /([0-9]+|[一二兩两])\s*部\s*轮椅/u,
    /\b(\d+|one|two|three|four|five)\s+wheelchairs?\b/iu
  ];
  let total = null;
  let totalEv = null;
  for (const re of totalPatterns) {
    const ev = evidenceForMatch(row, re);
    if (ev) {
      total = countWord(ev.groups?.[0] ?? ev.quote.match(re)?.[1]);
      totalEv = { ...ev, value: total };
      break;
    }
  }

  let foldable = null;
  let foldEv = null;
  const foldPatterns = [
    /只有\s*([0-9]+|[一])\s*部?\s*(?:摺得埋|摺得起|可摺疊?|折叠|折得起来)/u,
    /(one|only one|just one)\b[^.]{0,30}\b(foldable|folding|collapsible|collapsable)\b/iu,
    /([0-9]+)\s+of\s+(?:them|the wheelchairs?)[^.]{0,20}\b(foldable|folding|collapsible)/iu
  ];
  for (const re of foldPatterns) {
    const ev = evidenceForMatch(row, re);
    if (ev) {
      const n = ev.groups?.[1];
      foldable = /one|一/.test(String(n)) ? 1 : countWord(n);
      foldEv = ev;
      break;
    }
  }
  if (foldable == null && /摺得埋|可摺|foldable|folding|collaps/i.test(row.text)) {
    foldable = 1;
    foldEv = evidenceForMatch(row, /摺得埋|可摺[^，。；]*|foldable|folding|collapsible|collapsable/iu);
  }

  if (total != null || /輪椅|轮椅|wheelchair/iu.test(row.text)) {
    if (total == null) total = 1;
    if (foldable == null && /摺|fold|collaps/i.test(row.text)) foldable = null;
    const nonFoldable = foldable == null ? null : Math.max(0, total - foldable);
    const constraint = {
      code: 'wheelchairs',
      kind: 'hard',
      total,
      foldable,
      nonFoldable,
      evidence: [totalEv, foldEv].filter(Boolean)
    };
    out.constraints.push(constraint);
    out.claims.push({ code: 'wheelchair_profile', ...constraint });
    out.tags.push('wheelchair_user');
  }
}

function interpretCompanions(out, row) {
  const sentenceRe = /[^。！？!?\n]+[。！？!?]?/g;
  let m;
  while ((m = sentenceRe.exec(row.text))) {
    const sentence = m[0];
    if (!/一齊去|一齐去|一起去|一齊|一齐|一起|同行|分開|分开|separate|stay with|together with|with the teacher/iu.test(sentence)) continue;
    const people = peopleInSentence(sentence);
    const properName = sentence.match(/\b(?:Ms|Mr|Mrs|Miss|Teacher|Escort)\.?\s+([A-Z][A-Za-z'’-]+(?:\s+[A-Z][A-Za-z'’-]+)?)\b/u);
    if (properName) people.push(`contact:${properName[1].replace(/\s+/g, '_')}`);
    const ev = evidenceForMatch(row, new RegExp(sentence.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
    const inseparable = /不能|唔可以|不可|不得|must not|cannot|can't|never/iu.test(sentence)
      && /分開|分开|separate/iu.test(sentence);
    const together = /一齊|一齐|一起|一同|同行|together|stay with/iu.test(sentence);
    if (inseparable || together) {
      const subjects = people.length >= 2
        ? people
        : people.length === 1
          ? [people[0], 'companion']
          : ['participant', 'companion'];
      const relation = {
        code: 'companionship',
        kind: 'hard',
        type: inseparable ? 'must_not_separate' : 'must_stay_together',
        subjects,
        evidence: ev || { sentence }
      };
      out.relations.push(relation);
      out.constraints.push(relation);
      out.tags.push('companionship');
    }
  }
}

function interpretMobilityRequirements(out, row) {
  if (/短距離步行|短距离步行|短途步行|一小段路|短程|short walk|walk a short distance/iu.test(row.text)) {
    const ev = evidenceForMatch(row, /短距離步行|短距离步行|短途步行|一小段路|短程|short walk|walk a short distance/iu);
    out.constraints.push({ code: 'short_walk', kind: 'capability', maxDistance: 'short', evidence: ev });
    out.tags.push('short_walk');
  }

  const stepsEv = evidenceForMatch(row, /有台?階|有台阶|台?階|台阶|楼梯|樓梯|steps?|stairs?/iu);
  const railsEv = evidenceForMatch(row, /扶手|栏杆|欄杆|handrails?|rails?|banisters?/iu);
  if (stepsEv || railsEv) {
    out.constraints.push({
      code: 'steps_with_rails',
      kind: 'hard',
      requiresRails: true,
      stepsEvidence: stepsEv,
      railsEvidence: railsEv,
      evidence: [stepsEv, railsEv].filter(Boolean)
    });
    out.tags.push('steps_rails_required');
  }

  const liftEv = evidenceForMatch(row, /升降機|升降机|電梯|电梯|𨋢|lift|elevator/iu);
  if (liftEv) {
    const preference = / prefer|would be preferable|preferable|最好|希望|寧願|宁愿/iu.test(row.text);
    out.constraints.push({
      code: 'lift',
      kind: preference ? 'preference' : 'hard',
      evidence: liftEv
    });
    out.tags.push(preference ? 'lift_preference' : 'lift_required');
  }

  const window = parseTimeWindow(row.text);
  if (window) {
    const ev = evidenceForMatch(row, /[零〇一二两兩三四五六七八九十\d]{1,3}\s*[點点][^。；;]*(?:到|至|-|–|—)[^。；;]*[點点]?|between\s+[^.]+|(\d{1,2}(?::\d{2})?\s*(?:to|-)\s*\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?))/iu);
    out.constraints.push({ code: 'activity_window', kind: 'hard', ...window, evidence: ev });
    out.tags.push('activity_window');
  }
}

export function interpretRequirement(row) {
  const out = baseInterpretation(row, 'requirement');
  detectCommonConditions(out, row);
  interpretWheelchairRequirement(out, row);
  interpretCompanions(out, row);
  interpretMobilityRequirements(out, row);
  return out;
}

function interpretStepsResource(out, row) {
  const countEv = evidenceForMatch(row, /([0-9]+|[一二兩两三四五六七八九十]+)\s*(?:級|级|階|阶)/u);
  if (countEv) {
    const count = countWord(countEv.groups?.[0] ?? countEv.quote.match(/([0-9]+|[一二兩两三四五六七八九十]+)/)?.[1]);
    out.claims.push({ code: 'step_count', count, status: 'stated', evidence: countEv });
  } else if (/台?階|台阶|楼梯|樓梯|steps?|stairs?/i.test(row.text)) {
    const ev = evidenceForMatch(row, /台?階|台阶|楼梯|樓梯|steps?|stairs?/iu);
    out.claims.push({ code: 'steps_present', status: 'stated', evidence: ev });
  }

  const railsEv = evidenceForMatch(row, /都有扶手|有扶手|扶手|handrails?|rails?/iu);
  if (railsEv) out.claims.push({ code: 'rails_present', status: 'stated', evidence: railsEv });

  const noStepsEv = evidenceForMatch(row, /無台階|无台阶|無階|无阶|沒有台階|没有台阶|展厅内无台阶|展廳內無台階|no\s+steps?|step[-\s]?free/iu);
  if (noStepsEv) out.claims.push({ code: 'no_steps', status: 'stated', evidence: noStepsEv });

  const corridorEv = evidenceForMatch(row, /連廊|连廊|有蓋通道|有盖通道|走廊|corridor|covered walkway/iu);
  if (corridorEv) out.claims.push({ code: 'covered_corridor', status: 'stated', evidence: corridorEv });

  const rampEv = evidenceForMatch(row, /坡道|斜坡|斜道|無障礙通道|无障碍通道|ramp/iu);
  if (rampEv) out.claims.push({ code: 'ramp_present', status: 'stated', evidence: rampEv });

  const widthMatch = row.text.match(/(?:入口|通道|門|门)?[^。；;]{0,8}(?:寬度|宽度|寬|宽|width)[^。；;]{0,12}?(\d+(?:\.\d+)?)\s*(cm|厘米|公分|mm|毫米|m|米|in|inch|inches)?/iu)
    || row.text.match(/(\d+(?:\.\d+)?)\s*(cm|厘米|公分|mm|毫米|m|米|in|inch|inches)?\s*(?:寬|宽|wide)[^。；;]{0,8}(?:入口|通道|door|entrance)?/iu);
  if (widthMatch) {
    const value = Number(widthMatch[1]);
    let unit = (widthMatch[2] || 'cm').toLowerCase();
    let cm = value;
    if (unit === 'mm' || unit === '毫米') cm = value / 10;
    else if (unit === 'm' || unit === '米') cm = value * 100;
    else if (unit.startsWith('in')) cm = value * 2.54;
    const ev = evidenceForMatch(row, widthMatch[0]);
    out.claims.push({ code: 'opening_width', width: value, unit, widthCm: cm, status: 'stated', evidence: ev });
  }

  const duration = parseDurationMinutes(row.text);
  if (duration != null) {
    const ev = evidenceForMatch(row, /[零〇一二两兩三四五六七八九十\d]+\s*分(?:钟|鐘)?|(\d+)\s*(?:minute|min)s?/iu);
    out.claims.push({ code: 'walking_duration_minutes', minutes: duration, status: 'stated', evidence: ev });
  }
}

function interpretCapacityResource(out, row) {
  const wcCap = row.text.match(/接受\s*([0-9]+|[一二兩两三四五六七八九十]+)\s*部?\s*輪椅|接受\s*([0-9]+|[一二两三四五六七八九十]+)\s*部?\s*轮椅|accepts?\s+(\d+|two|one)\s+wheelchairs?/iu);
  if (wcCap) {
    const rawN = wcCap[1] || wcCap[2] || wcCap[3];
    const capacity = countWord(rawN);
    const ev = evidenceForMatch(row, wcCap[0]);
    out.claims.push({ code: 'wheelchair_capacity', capacity, status: 'stated', evidence: ev });
  }

  if (/全團同場|全团同场|全團|全团|整團|整团|可整團接待|whole group|entire group|all members/iu.test(row.text)) {
    const ev = evidenceForMatch(row, /全團同場[^。；;]*|全团同场[^。；;]*|可整團接待|可整团接待|全團|全团|整團|整团|whole group|entire group/iu);
    out.claims.push({ code: 'whole_group_reception', status: 'stated', evidence: ev });
  }

  if (/兩組同聽|两组同听|兩組|两组|two groups?/iu.test(row.text)) {
    const ev = evidenceForMatch(row, /[^\s。；;]*(?:兩組同聽|两组同听|兩組|两组|two groups?)[^。；;]*/iu);
    out.claims.push({ code: 'multiple_groups_same_session', status: 'stated', evidence: ev });
  }

  if (/小巴|接駁|接驳|shuttle|minibus|bus/iu.test(row.text)) {
    const ev = evidenceForMatch(row, /小巴可載輪椅|小巴可载轮椅|可載輪椅|可载轮椅|can carry wheelchairs?|wheelchair accessible/iu)
      || evidenceForMatch(row, /小巴|接駁|接驳|shuttle|minibus|bus/iu);
    out.claims.push({ code: 'shuttle_wheelchair_statement', status: 'ambiguous', evidence: ev });
  }
}

export function interpretResource(row) {
  const out = baseInterpretation(row, 'resource');
  detectCommonConditions(out, row);
  detectGenericAccessibility(out, row);
  interpretStepsResource(out, row);
  interpretCapacityResource(out, row);
  return out;
}

export function interpretReply(row) {
  const out = baseInterpretation(row, 'reply');
  detectCommonConditions(out, row);
  detectGenericAccessibility(out, row);
  interpretCapacityResource(out, row);

  if (/席位|名額|名额|座位|seats?|availability|available/iu.test(row.text)) {
    const ev = evidenceForMatch(row, /[^\s。；;]*(?:仍有席位|有席位|名額|名额|座位|seats?|availability|available)[^。；;]*/iu);
    out.claims.push({ code: 'session_availability', status: 'confirmed', evidence: ev });
  }
  if (/等到|等至|開放時間已核實|开放时间已核实|已核實|已核实|wait(?:s)? until|verified|confirmed/iu.test(row.text)) {
    const ev = evidenceForMatch(row, /講師等到[^。；;]*|讲师等到[^。；;]*|走廊開放時間已核實|走廊开放时间已核实|[^。；;]*(?:已核實|已核实|verified|confirmed)[^。；;]*/iu);
    out.claims.push({ code: 'operational_detail_confirmed', status: 'confirmed', evidence: ev });
  }
  if (/僅指|仅指|只指|只能|無法載|无法载|不能載|不能载|only.*(?:foldable|folding)|cannot carry|can't take/iu.test(row.text)) {
    const foldableOnly = /僅指可折疊|仅指可折叠|只指可折叠|可折疊型|可折叠型|foldable|folding|collaps/iu.test(row.text);
    const cannotNonFoldable = /無法載不能折疊|无法载不能折叠|不能載不能折|cannot carry the non-fold|non-foldable/iu.test(row.text);
    const ev = evidenceForMatch(row, /[^。；;]*(?:僅指|仅指|只指|無法載|无法载|不能載|不能载|only|cannot carry)[^。；;]*/iu);
    out.claims.push({
      code: 'correction',
      status: 'supersedes',
      foldableOnly,
      deniesNonFoldable: cannotNonFoldable || foldableOnly,
      evidence: ev
    });
    out.tags.push('correction');
  }
  return out;
}

export function interpretRecord(row) {
  if (row.group !== undefined || row.locale !== undefined) return interpretRequirement(row);
  if (row.from !== undefined || row.slot !== undefined || row.type !== undefined) return interpretResource(row);
  return interpretReply(row);
}

export const interpretRequirements = (rows = []) => rows.map(interpretRequirement);
export const interpretResources = (rows = []) => rows.map(interpretResource);
export const interpretReplies = (rows = []) => rows.map(interpretReply);
export function interpretTables(tables = {}) {
  const requirements = tables.requirements || tables['需求.json'] || [];
  const resources = tables.resources || tables['资源.json'] || [];
  const replies = tables.replies || tables['接待回复.json'] || [];
  return {
    requirements: interpretRequirements(requirements),
    resources: interpretResources(resources),
    replies: interpretReplies(replies)
  };
}
export const parseRequirements = interpretRequirements;
export const parseResources = interpretResources;
export const parseReplies = interpretReplies;
