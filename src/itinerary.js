// 候选路线构建与承诺判定。
// 不变量（每条可承诺路线都必须满足）：
//   A. 团员分组不变：约定同行的人走同一交通段、参加同一场次；
//   B. 相邻路段可连接：上一段的 to 必须等于下一段的 from，且时间不倒退；
//   C. 场馆已确认的接待条件成立，被更正的宣传文案不得采信；
//   D. 组内存在 blocked 路段的路线不可承诺；unknown 路段只能列为“尚不确定”。

import { assessSegment } from './assessment.js';

/**
 * 在路段图上枚举以讲解活动收尾的全部候选路线。
 * @param {import('./types.js').Segment[]} segments
 * @returns {Array<{ route: import('./types.js').Segment[], connectivity: Array<{ok:boolean, reason:string}> }>}
 */
export function enumerateRoutes(segments) {
  const outgoing = new Map();
  for (const segment of segments) {
    if (!outgoing.has(segment.from)) outgoing.set(segment.from, []);
    outgoing.get(segment.from).push(segment);
  }
  // 入口路段（没有任何路段能在时间上接入它）各自成根；
  // 场馆可有多个入口（北门、西门），不能因为某地点在另一条路线里出现过就排除该入口路线。
  const roots = segments.filter(segment =>
    !segments.some(other =>
      other.id !== segment.id &&
      other.to === segment.from &&
      (other.slotMinutes === null || segment.slotMinutes === null ||
        other.slotMinutes <= segment.slotMinutes)));

  const results = [];
  const walk = (route, connectivity) => {
    const current = route[route.length - 1];
    if (current.type === '讲解') {
      results.push({ route: [...route], connectivity: [...connectivity] });
      // 讲解后一般不再接续；资料中讲解段终点即自身
      return;
    }
    const nexts = outgoing.get(current.to) ?? [];
    for (const next of nexts) {
      const placeOk = current.to === next.from;
      const timeOk = current.slotMinutes === null || next.slotMinutes === null ||
        next.slotMinutes >= current.slotMinutes;
      const stepChecks = [
        ...connectivity,
        {
          ok: placeOk && timeOk,
          reason: !placeOk
            ? `地点不连接：${current.id} 止于「${current.to}」，${next.id} 始于「${next.from}」`
            : !timeOk
              ? `时间倒退：${current.id}(${current.slot}) 晚于 ${next.id}(${next.slot})`
              : `${current.id} -> ${next.id} 地点与时间均可连接`
        }
      ];
      walk([...route, next], stepChecks);
    }
  };

  for (const root of roots) {
    walk([root], []);
  }
  return results;
}

/**
 * 评估单个组的全部候选路线。
 * @returns {Array<{
 *   segmentIds: string[],
 *   connectivity: Array<{ok:boolean, reason:string}>,
 *   assessments: import('./types.js').SegmentAssessment[],
 *   committable: boolean,
 *   uncertainSegments: string[],
 *   blockedSegments: string[],
 *   obligations: Array<{segmentId:string, message:string}>,
 *   lostPreferences: Array<{segmentId:string, message:string}>
 * }>}
 */
export function evaluateRoutesForGroup(group, needs, segments, replies) {
  const byId = new Map(segments.map(segment => [segment.id, segment]));
  return enumerateRoutes(segments).map(({ route, connectivity }) => {
    const assessments = route.map(segment => assessSegment(group, needs, segment, replies));
    const connected = connectivity.every(step => step.ok);
    const blockedSegments = assessments
      .filter(a => a.status === 'blocked').map(a => a.segmentId);
    const uncertainSegments = assessments
      .filter(a => a.status === 'uncertain').map(a => a.segmentId);
    const obligations = assessments.flatMap(a =>
      a.findings.filter(f => f.status === 'obligation')
        .map(f => ({ segmentId: a.segmentId, message: f.message, basis: f.basis })));
    const lostPreferences = assessments.flatMap(a =>
      a.findings.filter(f => f.status === 'preference-lost')
        .map(f => ({ segmentId: a.segmentId, message: f.message, basis: f.basis })));

    return {
      segmentIds: route.map(segment => segment.id),
      labels: route.map(segment => `${segment.id}（${segment.from}→${segment.to} ${segment.slot}）`),
      connectivity,
      connected,
      assessments,
      committable: connected && blockedSegments.length === 0 && uncertainSegments.length === 0,
      uncertainSegments,
      blockedSegments,
      obligations,
      lostPreferences,
      segmentById: byId
    };
  });
}

/**
 * 多组排程：校验同行约束。
 * - 约定同行的人必须在同一路线内（不拆分到不同交通段/场次）；
 * - 两组可以错开使用讲解厅（不同 讲解 段），也可以同场（同一段）。
 *
 * @param {Map<string, object[]>} needsByGroup  parseNeeds().groups
 * @param {Record<string, string[]>} chosenRouteByGroup 每组选定的路线（段编号数组）
 * @param {Map<string, import('./types.js').Segment>} segmentById
 */
export function validateGrouping(needsByGroup, chosenRouteByGroup, segmentById) {
  const violations = [];
  for (const [group, needs] of needsByGroup) {
    const route = chosenRouteByGroup[group];
    if (!route) {
      violations.push({ group, reason: '该组没有选定路线，无法承诺同行安排。' });
      continue;
    }
    const hasAccompanyNeed = needs.some(need => need.kind === 'accompany-teacher');
    if (hasAccompanyNeed) {
      // 每条交通段与每个场次对该组只能出现一次：重复出现即意味组被拆开安排
      const seen = new Set();
      for (const id of route) {
        if (seen.has(id)) {
          violations.push({ group, reason: `路线把同组拆散到重复路段：${id}` });
        }
        seen.add(id);
      }
    }
  }

  // 不同组之间：允许同场或错场；共用讲解段=同场，否则=错开使用讲解厅
  const groupNames = Object.keys(chosenRouteByGroup);
  const sessionPairs = [];
  for (let i = 0; i < groupNames.length; i += 1) {
    for (let j = i + 1; j < groupNames.length; j += 1) {
      const a = chosenRouteByGroup[groupNames[i]] ?? [];
      const b = chosenRouteByGroup[groupNames[j]] ?? [];
      const sharedSession = a.some(id =>
        b.includes(id) && segmentById.get(id)?.type === '讲解');
      sessionPairs.push({
        groups: [groupNames[i], groupNames[j]],
        sharedSession,
        note: sharedSession ? '两组同场' : '两组错开使用讲解厅'
      });
    }
  }
  return { violations, sessionPairs };
}
