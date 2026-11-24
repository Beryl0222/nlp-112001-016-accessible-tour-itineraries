import { getGroupProfile, companionClosure, analyzeMaterials } from './analysis.js';
import { validateAssignment } from './ledger.js';
import { interpretResource } from './interpret.js';
import { formatClock, parseClock } from './text-utils.js';

const STATUS_RANK = { committable: 3, needs_confirmation: 2, unavailable: 1 };

function resourceMinutes(r) {
  if (Number.isInteger(r.slotMinutes)) return r.slotMinutes;
  return parseClock(r.slot);
}

function durationMinutes(r) {
  const claim = r.claims?.find(c => c.code === 'walking_duration_minutes');
  return claim?.minutes ?? 0;
}

export function findRoutes(analysisOrResources, options = {}) {
  const resources = Array.isArray(analysisOrResources)
    ? analysisOrResources
    : analysisOrResources.resources;
  const list = resources.map(r => ({
    ...(r.claims || r.constraints ? r : interpretResource(r)),
    slotMinutes: resourceMinutes(r)
  }));
  const byId = Object.fromEntries(list.map(r => [r.id, r]));
  const complete = [];
  const broken = [];
  const seen = new Set();

  function connection(a, b) {
    const issues = [];
    if (a.to !== b.from) {
      issues.push({ code: 'endpoint_mismatch', severity: 'blocker', from: a.id, to: b.id, message: `${a.id} 到「${a.to}」，但 ${b.id} 由「${b.from}」出发，相邻路段接不上。` });
    }
    const am = a.slotMinutes;
    const bm = b.slotMinutes;
    if (Number.isInteger(am) && Number.isInteger(bm)) {
      const arrival = am + durationMinutes(a);
      if (bm < am || bm < arrival) {
        issues.push({
          code: 'time_conflict',
          severity: 'blocker',
          from: a.id,
          to: b.id,
          message: `${a.id} ${formatClock(am)}${durationMinutes(a) ? `，预计 ${formatClock(arrival)} 到达` : ''}，无法接上 ${b.id} ${formatClock(bm)}。`
        });
      }
    } else {
      issues.push({ code: 'time_unverified', severity: 'uncertain', from: a.id, to: b.id, message: `${a.id} 与 ${b.id} 缺少可比较的时刻，连接时间尚待核实。` });
    }
    return { ok: issues.every(i => i.severity !== 'blocker'), issues };
  }

  function walk(path) {
    const ids = path.map(r => r.id);
    const key = ids.join('>');
    const last = path[path.length - 1];
    const isActivity = /讲解|活动|session|talk|activity/i.test(`${last.type} ${last.text}`);
    if (isActivity && path.length > 1 && !seen.has(key)) {
      seen.add(key);
      const connections = [];
      for (let i = 1; i < path.length; i += 1) connections.push(connection(path[i - 1], path[i]));
      complete.push(makeRoute(path, connections));
    }

    for (const next of list) {
      if (ids.includes(next.id)) continue;
      if (last.to !== next.from) continue;
      const conn = connection(last, next);
      if (!conn.ok) {
        const badKey = [...ids, next.id].join('>');
        if (!seen.has(`broken:${badKey}`)) {
          seen.add(`broken:${badKey}`);
          broken.push({
            id: `broken:${badKey}`,
            resourceIds: [...ids, next.id],
            connections: [conn],
            message: conn.issues.map(i => i.message).join(' ')
          });
        }
        // A time-incompatible extension is reported as a broken connection,
        // not promoted to a bookable route.
        continue;
      }
      walk([...path, next]);
    }
  }

  for (const r of list) walk([r]);

  complete.sort((a, b) => a.resourceIds.join().localeCompare(b.resourceIds.join()));
  return { routes: complete, brokenConnections: broken };
}

function makeRoute(path, connections) {
  const blocking = connections.flatMap(c => c.issues).filter(i => i.severity === 'blocker');
  return {
    id: `route:${path.map(r => r.id).join('>')}`,
    resourceIds: path.map(r => r.id),
    segments: path,
    sessionIds: path.filter(r => /讲解|活动|session|talk|activity/i.test(`${r.type} ${r.text}`)).map(r => r.id),
    places: [...new Set(path.flatMap(r => [r.from, r.to]).filter(Boolean))],
    startSlot: path[0]?.slot ?? null,
    connection: { ok: blocking.length === 0, issues: connections.flatMap(c => c.issues) }
  };
}

export function currentEvidenceFor(analysis, segmentId) {
  const resource = analysis?.byId?.[segmentId] || segmentId;
  const links = analysis?.links?.filter(l => l.resourceIds.includes(segmentId)) || [];
  const replyIds = new Set(links.flatMap(l => [l.replyId]));
  // Direct source match is a fallback for hand-built analyses.
  if (analysis?.replies) {
    for (const reply of analysis.replies) {
      if (reply.source && resource && (reply.source === resource.to || reply.source === resource.from)) replyIds.add(reply.id);
      if (/接驳方|shuttle/i.test(reply.source || '') && /接驳|shuttle/i.test(resource?.type || '')) replyIds.add(reply.id);
    }
  }
  let replies = [...replyIds].map(id => analysis.byId[id]).filter(Boolean);
  replies = replies.sort(compareReceived);
  const corrections = replies.filter(r => r.tags?.includes('correction') || r.claims?.some(c => c.code === 'correction'));
  return { resource, links, replies, corrections };
}

function receivedOrder(value) {
  const raw = value?.received || value;
  if (raw == null) return Number.NEGATIVE_INFINITY;
  const text = String(raw);
  if (/^\d{1,2}:\d{2}$/.test(text)) return parseClock(text);
  const clock = parseClock(text);
  if (clock != null && !/\d{4}-\d{2}-\d{2}|[/-]\d{1,2}[/-]/.test(text)) return clock;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? (clock ?? Number.NEGATIVE_INFINITY) : parsed;
}

function compareReceived(a, b) {
  return receivedOrder(a) - receivedOrder(b);
}

function claim(r, code) {
  return r?.claims?.find(c => c.code === code) || null;
}
function claims(r, code) {
  return r?.claims?.filter(c => c.code === code) || [];
}

function issue(code, severity, segmentId, message, extra = {}) {
  return { code, severity, segmentId, message, ...extra };
}

function confirmationValue(options, segmentId, code) {
  const c = options.confirmations?.[segmentId] || options.confirmations?.[code] || options;
  if (!c) return false;
  if (Array.isArray(c.confirmed) && (c.confirmed.includes(code) || c.confirmed.includes('all'))) return true;
  return c[code] === true || c[`${code}Confirmed`] === true;
}

export function evaluateSegment(analysis, segmentInput, group, options = {}) {
  const segment = segmentInput.claims || segmentInput.constraints ? segmentInput : interpretResource(segmentInput);
  const result = {
    segmentId: segment.id,
    type: segment.type,
    status: 'committable',
    issues: [],
    evidence: [],
    met: []
  };
  const ctx = currentEvidenceFor(analysis, segment.id);
  result.evidence.push(...(segment.evidence || []), ...ctx.replies.flatMap(r => r.evidence || []));
  const add = i => { result.issues.push(i); };
  const confirm = code => confirmationValue(options, segment.id, code);

  // Time window applies most directly to announced activities.
  if (group?.timeWindows?.length && /讲解|活动|session|talk|activity/i.test(`${segment.type} ${segment.text}`)) {
    const t = parseClock(segment.slot);
    for (const w of group.timeWindows) {
      if (t == null) {
        add(issue('time_unknown', 'uncertain', segment.id, `${segment.id} 缺少可解析时刻，无法判断是否在团方期望时段内。`, { evidence: segment.evidence }));
      } else if (t < w.start || t > w.end) {
        add(issue('outside_time_window', 'blocker', segment.id, `${segment.id} 的 ${formatClock(t)} 不在团方期望的 ${formatClock(w.start)}–${formatClock(w.end)} 内。`, { evidence: w.evidence }));
      } else {
        result.met.push('activity_window');
      }
    }
  }

  // Generic marketing language can never prove a hard requirement.
  const generic = claim(segment, 'generic_accessibility_marketing');
  if (generic) {
    add(issue('generic_accessibility_unverified', 'uncertain', segment.id, `「${generic.evidence.quote}」只是笼统宣传，不能证明轮椅、台阶、接驳或讲解厅条件。`, { evidence: [generic.evidence] }));
  }

  // Walking / entrance access.
  if (/步行|入口|walking|entrance/i.test(`${segment.type} ${segment.text}`)) {
    const noSteps = claim(segment, 'no_steps');
    const steps = claim(segment, 'steps_present') || claim(segment, 'step_count');
    const rails = claim(segment, 'rails_present');

    if (group?.hardRequirements?.includes('steps_with_rails')) {
      if (noSteps) {
        result.met.push('step_free');
      } else if (steps && rails) {
        result.met.push('steps_with_rails');
      } else if (steps && !rails) {
        add(issue('rails_missing', 'blocker', segment.id, `${segment.id} 提到台阶但未说明扶手，不满足“台阶需有扶手”的硬性要求。`, { evidence: [steps.evidence] }));
      } else if (rails && !steps) {
        result.met.push('rails_present');
      } else {
        add(issue('step_condition_unknown', 'uncertain', segment.id, `${segment.id} 未具体说明台阶和扶手，不能据宣传判断步行条件。`, { evidence: segment.evidence }));
      }
    }

    if (group?.wheelchairs && !noSteps) {
      const widthCondition = segment.conditions?.find(c => c.code === 'wheelchair_width');
      const ramp = claim(segment, 'ramp_present');
      const openingWidth = claim(segment, 'opening_width');
      const chairWidth = options.wheelchairWidthCm || group.wheelchairs.maxWidthCm;
      const widthTooNarrow = openingWidth && chairWidth && openingWidth.widthCm < chairWidth;

      if (widthTooNarrow) {
        add(issue('wheelchair_width_insufficient', 'blocker', segment.id, `${segment.id} 宽度约 ${openingWidth.widthCm}cm，小于已知轮椅宽度 ${chairWidth}cm。`, { evidence: [openingWidth.evidence] }));
      } else if (widthCondition && !confirm('wheelchair_width') && !options.wheelchairWidthCompatible) {
        add(issue('wheelchair_width_unconfirmed', 'uncertain', segment.id, `「${widthCondition.evidence.quote}」必须量度并确认该团轮椅宽度后才能承诺。`, { evidence: [widthCondition.evidence] }));
      } else if (ramp || confirm('wheelchair_access')) {
        result.met.push('wheelchair_access_confirmed');
        if (ramp?.evidence) result.evidence.push(ramp.evidence);
      } else if (steps || /台?階|台阶|楼梯/i.test(segment.text)) {
        if (options.ambulantWheelchairUsers) {
          result.met.push('wheelchair_step_access_confirmed');
        } else {
          add(issue('wheelchair_step_access_unconfirmed', 'uncertain', segment.id, `${segment.id} 有台阶/扶手，但扶手不等于轮椅通道；需确认坡道、电梯或协助接送安排。`, { evidence: [steps?.evidence, rails?.evidence].filter(Boolean) }));
        }
      } else if (!confirm('wheelchair_access')) {
        add(issue('wheelchair_access_unconfirmed', 'uncertain', segment.id, `${segment.id} 没有给出轮椅可通行的具体依据。`, { evidence: segment.evidence }));
      }
    }

    const rain = segment.conditions?.find(c => c.code === 'weather_rain');
    if (rain) {
      if (options.weather === 'rain') {
        add(issue('weather_rain_suspended', 'blocker', segment.id, `「${rain.evidence.quote}」；雨天该段停行，当前不能使用。`, { evidence: [rain.evidence] }));
      } else if (options.weather === 'dry') {
        result.met.push('weather_dry_operating');
      } else {
        add(issue('weather_condition_unconfirmed', 'condition', segment.id, `该段附有「${rain.evidence.quote}」条件；未确认天气或雨天替代安排前，不能作无条件承诺。`, { evidence: [rain.evidence] }));
      }
    }
  }

  // Shuttle.
  if (/接驳|shuttle|transport/i.test(`${segment.type} ${segment.text}`)) {
    const wc = group?.wheelchairs;
    const shuttleClaim = claim(segment, 'shuttle_wheelchair_statement');
    const correction = ctx.corrections.flatMap(r => r.claims.filter(c => c.code === 'correction')).at(-1);
    const widthCondition = segment.conditions?.find(c => c.code === 'wheelchair_width')
      || ctx.replies.flatMap(r => r.conditions).find(c => c.code === 'wheelchair_width');

    if (wc?.total > 0) {
      if (widthCondition && !confirm('wheelchair_width') && !options.wheelchairWidthCompatible) {
        add(issue('shuttle_width_unconfirmed', 'uncertain', segment.id, `接驳条件「${widthCondition.evidence.quote}」尚未与本团轮椅核对。`, { evidence: [widthCondition.evidence] }));
      }
      if (correction?.deniesNonFoldable && wc.nonFoldable > 0 && !options.replacedAccessibleVehicle) {
        const ev = correction.evidence;
        add(issue('non_foldable_wheelchair_denied', 'blocker', segment.id, `${ctx.replies.at(-1)?.source || '接驳方'}澄清「${ev.quote}」；本团有 ${wc.nonFoldable} 部不能折叠的轮椅，${segment.id} 不能载运。`, { evidence: [shuttleClaim?.evidence, ev].filter(Boolean) }));
      } else if (correction?.foldableOnly) {
        if (wc.nonFoldable === 0) result.met.push('foldable_wheelchair_carriage_confirmed');
        else if (options.replacedAccessibleVehicle) result.met.push('replacement_accessible_vehicle_confirmed');
      } else if (shuttleClaim && !confirm('shuttle_wheelchair_type')) {
        add(issue('shuttle_wheelchair_type_unconfirmed', 'uncertain', segment.id, `原说明「${shuttleClaim.evidence.quote}」未说明是否只限折叠型或宽度限制，承诺前须向接驳单位确认。`, { evidence: [shuttleClaim.evidence] }));
      }
      if (wc.total > 1 && !claim(segment, 'wheelchair_capacity') && !confirm('shuttle_wheelchair_capacity')) {
        add(issue('shuttle_wheelchair_capacity_unconfirmed', 'uncertain', segment.id, `接驳说明未写明可同时载运 ${wc.total} 部轮椅或全团同车，需确认班次/座位。`, { evidence: segment.evidence }));
      }
    }
  }

  // Talks / reception.
  if (/讲解|活动|talk|activity/i.test(`${segment.type} ${segment.text}`)) {
    const wcCapacity = claim(segment, 'wheelchair_capacity');
    const wc = group?.wheelchairs;
    const availability = ctx.replies.flatMap(r => claims(r, 'session_availability')).at(-1);
    const wholeGroup = claim(segment, 'whole_group_reception');
    if (wc?.total > 0) {
        if (wcCapacity && wcCapacity.capacity >= wc.total) result.met.push('wheelchair_capacity');
        else if (wcCapacity && wcCapacity.capacity < wc.total) {
          add(issue('wheelchair_capacity_insufficient', 'blocker', segment.id, `${segment.id} 只接待 ${wcCapacity.capacity} 部轮椅，少于本团 ${wc.total} 部。`, { evidence: [wcCapacity.evidence] }));
        } else if (confirm('wheelchair_capacity') || (wholeGroup && availability)) {
          result.met.push('wheelchair_capacity_confirmed_for_group');
        } else {
          add(issue('wheelchair_capacity_unconfirmed', 'uncertain', segment.id, `${segment.id} 未确认可容纳本团 ${wc.total} 部轮椅。`, {}));
        }
      }

    const advance = segment.conditions?.find(c => c.code === 'advance_arrangement');
    const sameSessionReply = ctx.replies.find(r =>
      r.claims.some(c => ['session_availability', 'multiple_groups_same_session', 'operational_detail_confirmed'].includes(c.code))
    );
    if (advance && !sameSessionReply && !confirm('advance_arrangement')) {
      add(issue('advance_arrangement_required', 'condition', segment.id, `「${advance.evidence.quote}」尚未完成或取得场馆确认。`, { evidence: [advance.evidence] }));
    } else if (advance) {
      result.met.push('advance_arrangement_confirmed');
    }

    const multiGroup = claim(segment, 'multiple_groups_same_session') || ctx.replies.flatMap(r => claims(r, 'multiple_groups_same_session')).at(-1);
    if (availability || wholeGroup || multiGroup) {
      result.met.push('venue_reception_confirmed');
      if (availability?.evidence) result.evidence.push(availability.evidence);
      if (multiGroup?.evidence) result.evidence.push(multiGroup.evidence);
    } else if (!confirm('venue_reception')) {
      add(issue('venue_reception_unconfirmed', 'uncertain', segment.id, `${segment.id} 缺少场馆就该场次、人数和接待条件的当前确认。`, { evidence: segment.evidence }));
    }
  }

  // Conditions can be attached by a venue to entrances, reception rules or any
  // other resource type, not only to the familiar sample types.
  for (const condition of segment.conditions || []) {
    const exists = code => result.issues.some(i => i.code === code);
    if (condition.code === 'weather_rain' && !exists('weather_condition_unconfirmed') && !exists('weather_rain_suspended')) {
      if (options.weather === 'rain') {
        add(issue('weather_rain_suspended', 'blocker', segment.id, `「${condition.evidence.quote}」；雨天该段停行，当前不能使用。`, { evidence: [condition.evidence] }));
      } else if (options.weather !== 'dry') {
        add(issue('weather_condition_unconfirmed', 'condition', segment.id, `该段附有「${condition.evidence.quote}」条件；未确认天气或雨天替代安排前，不能作无条件承诺。`, { evidence: [condition.evidence] }));
      }
    }
    if (condition.code === 'advance_arrangement' && !exists('advance_arrangement_required') && !result.met.includes('advance_arrangement_confirmed')) {
      const confirmedReply = ctx.replies.some(r => r.claims.some(c => ['session_availability', 'multiple_groups_same_session', 'operational_detail_confirmed'].includes(c.code)));
      if (!confirmedReply && !confirm('advance_arrangement')) {
        add(issue('advance_arrangement_required', 'condition', segment.id, `「${condition.evidence.quote}」尚未完成或取得场馆确认。`, { evidence: [condition.evidence] }));
      } else {
        result.met.push('advance_arrangement_confirmed');
      }
    }
    if (condition.code === 'wheelchair_width' && group?.wheelchairs && !exists('wheelchair_width_unconfirmed') && !exists('shuttle_width_unconfirmed')) {
      if (!confirm('wheelchair_width') && !options.wheelchairWidthCompatible) {
        add(issue('wheelchair_width_unconfirmed', 'uncertain', segment.id, `「${condition.evidence.quote}」必须量度并确认该团轮椅宽度后才能承诺。`, { evidence: [condition.evidence] }));
      }
    }
  }

  if (result.issues.some(i => i.severity === 'blocker')) result.status = 'unavailable';
  else if (result.issues.length > 0) result.status = 'needs_confirmation';
  else result.status = 'committable';
  result.decision = {
    committable: '可承诺',
    needs_confirmation: '尚不确定·待确认',
    unavailable: '不可承诺'
  }[result.status];
  result.state = result.status === 'committable' ? 'confirmed' : result.status === 'needs_confirmation' ? 'uncertain' : 'denied';
  result.verdict = result.state;
  result.canPromise = result.status === 'committable';
  return result;
}

function evaluateGrouping(group, options) {
  const companionGroups = options.companionGroups || group?.companionGroups || companionClosure(options.relations || []);
  if (options.assignment || options.assignments) {
    const result = validateAssignment({
      companionGroups,
      assignments: options.assignment?.assignments || options.assignments || options.assignment
    });
    return { ok: result.ok, companionGroups, errors: result.errors };
  }
  // A single selected route keeps every member of the profile together.
  return { ok: true, companionGroups, errors: [] };
}

export function evaluateRoute(analysis, route, group, options = {}) {
  const segmentAssessments = route.segments.map(s => evaluateSegment(analysis, s, group, options));
  const grouping = evaluateGrouping(group, options);
  const issues = [
    ...route.connection.issues,
    ...(grouping.errors || []).map(e => ({
      code: e.code,
      severity: 'blocker',
      message: e.code === 'companions_split_sessions'
        ? `约定同行者被分到不同场次（${e.sessions.join('、')}），不能作为可承诺路线。`
        : `约定同行者在同一交通段中被拆开（${e.legId}），不能作为可承诺路线。`,
      detail: e
    })),
    ...segmentAssessments.flatMap(a => a.issues)
  ];
  const status = issues.some(i => i.severity === 'blocker')
    ? 'unavailable'
    : issues.length
      ? 'needs_confirmation'
      : 'committable';

  const sacrificedPreferences = [];
  if (group?.preferences?.includes('lift')) {
    const hasUsableSteps = route.segments.some(s => {
      const steps = claim(s, 'steps_present') || claim(s, 'step_count');
      const noSteps = claim(s, 'no_steps');
      return steps && !noSteps;
    });
    if (hasUsableSteps) {
      sacrificedPreferences.push({ code: 'lift', message: '此路线舍弃“优先乘升降机”的偏好，但保留“有扶手台阶可通行”的硬条件。' });
    }
  }

  const decisionLabels = {
    committable: '可承诺',
    needs_confirmation: '尚不确定·待确认',
    unavailable: '不可承诺'
  };
  const canonicalState = status === 'committable' ? 'confirmed' : status === 'needs_confirmation' ? 'uncertain' : 'denied';
  return {
    id: route.id,
    group: group?.group || options.group || null,
    resourceIds: route.resourceIds,
    segmentIds: route.resourceIds,
    sessionIds: route.sessionIds,
    places: route.places,
    status,
    statusCode: status,
    state: canonicalState,
    verdict: canonicalState,
    decision: decisionLabels[status],
    statusZh: decisionLabels[status],
    committable: status === 'committable',
    canPromise: status === 'committable',
    promisable: status === 'committable',
    uncertain: status === 'needs_confirmation',
    connection: route.connection,
    grouping,
    segments: segmentAssessments,
    issues,
    sacrificedPreferences,
    adjustments: buildAdjustments(route, issues, group, options.allRoutes || [])
  };
}

function buildAdjustments(route, issues, group, allRoutes = []) {
  const out = [];
  for (const issue of issues) {
    if (issue.code === 'non_foldable_wheelchair_denied') {
      out.push({
        code: 'narrow_wheelchair_requirement',
        message: '团方可缩小需求：不携带那部不能折叠的轮椅，或改用可折叠型；随后只需重约受影响的接驳段及绑定同场的接待。',
        affects: [issue.segmentId, ...route.sessionIds]
      });
      out.push({
        code: 'replace_shuttle',
        message: '另派可载运非折叠轮椅/符合宽度的无障碍车辆，并让接驳方重新确认该班次。',
        affects: [issue.segmentId]
      });
      const alternative = allRoutes.find(candidate =>
        candidate.id !== route.id
        && candidate.connection?.ok
        && candidate.sessionIds?.length
        && !candidate.resourceIds.includes(issue.segmentId)
      );
      out.push({
        code: 'switch_entrance_route',
        message: alternative
          ? `改用另一个入口及可连接的后续讲解：候选 ${alternative.resourceIds.join(' → ')}；仍须完成该候选上未决的轮椅/天气确认。`
          : '改用另一个入口时，必须重新寻找端点、时刻都连得上的后续讲解场次，不能只确认入口可达。',
        affects: alternative?.resourceIds || []
      });
    }
    if (issue.code === 'wheelchair_step_access_unconfirmed') {
      out.push({ code: 'confirm_step_assist', message: '请小展厅/场地确认坡道、升降设备或员工协助；若无法提供，应改走无台阶路线。', affects: [issue.segmentId] });
    }
    if (issue.code === 'weather_condition_unconfirmed') {
      out.push({ code: 'weather_contingency', message: '确认活动当日天气，或预留有盖走廊/室内替代段；雨天不得把“雨天停行”的路段承诺为可行。', affects: [issue.segmentId] });
    }
    if (issue.code === 'time_conflict') {
      out.push({ code: 'use_direct_entrance', message: '不要把迟到的西门至北门段接到已开出的路段；可直接由北门参加较早段，或把后一段改到已确认的更晚场次。', affects: [issue.from, issue.to] });
    }
  }
  return out;
}

export function planItineraries(inputAnalysis, options = {}) {
  let analysis = inputAnalysis;
  const looksLikeAnalysis = analysis?.resources && analysis?.byId;
  if (!looksLikeAnalysis && (Array.isArray(analysis) || analysis?.['资源.json'] || analysis?.['需求.json'] || analysis?.['接待回复.json'])) {
    analysis = analyzeMaterials(analysis);
  }
  const group = options.groupProfile || getGroupProfile(analysis, options.group);
  const { routes, brokenConnections } = findRoutes(analysis);
  const plans = routes.map(r => evaluateRoute(analysis, r, group, { ...options, allRoutes: routes }));
  const allSegmentAssessments = analysis?.resources
    ? analysis.resources.map(s => evaluateSegment(analysis, s, group, options))
    : [];
  plans.sort((a, b) => STATUS_RANK[b.status] - STATUS_RANK[a.status] || a.id.localeCompare(b.id));
  return {
    group: group?.group || options.group || null,
    groupProfile: group,
    plans,
    segmentAssessments: allSegmentAssessments,
    brokenConnections,
    committablePlans: plans.filter(p => p.committable),
    pendingPlans: plans.filter(p => p.status === 'needs_confirmation'),
    unavailablePlans: plans.filter(p => p.status === 'unavailable')
  };
}

export const planForGroup = planItineraries;
export const assessRoutes = planItineraries;
