import { interpretRequirement, interpretReply, interpretResource } from './interpret.js';
import { parseClock } from './text-utils.js';

export function normalizeTables(input = {}) {
  if (Array.isArray(input)) {
    if (input.some(r => r && ('from' in r || 'slot' in r || 'type' in r))) {
      return { requirements: [], resources: input, replies: [] };
    }
    if (input.some(r => r && ('source' in r || 'received' in r))) {
      return { requirements: [], resources: [], replies: input };
    }
    return { requirements: input, resources: [], replies: [] };
  }
  const req = input.requirements || input['需求.json'] || input.需求 || input.needs || [];
  const resources = input.resources || input['资源.json'] || input.资源 || input.segments || [];
  const replies = input.replies || input['接待回复.json'] || input.接待回复 || input.responses || [];
  return { requirements: req, resources, replies };
}

function inferKind(row) {
  if (row.group !== undefined || row.locale !== undefined) return 'requirement';
  if (row.from !== undefined || row.to !== undefined || row.slot !== undefined || row.type !== undefined) return 'resource';
  return 'reply';
}

export function analyzeMaterials(input) {
  // Convenience: callers may pass the exact object returned by readMaterials,
  // English tables, a single record, or an array of mixed records.
  let tables;
  if (Array.isArray(input) && input.some(inferKind)) {
    const mixed = input;
    tables = {
      requirements: mixed.filter(r => inferKind(r) === 'requirement'),
      resources: mixed.filter(r => inferKind(r) === 'resource'),
      replies: mixed.filter(r => inferKind(r) === 'reply')
    };
  } else if (input && (input.requirements || input['需求.json'] || input.resources || input['资源.json'] || input.replies || input['接待回复.json'])) {
    tables = normalizeTables(input);
  } else if (input && typeof input === 'object' && inferKind(input)) {
    const kind = inferKind(input);
    tables = { requirements: [], resources: [], replies: [], [`${kind}s`]: [input] };
  } else {
    tables = normalizeTables(input);
  }

  const requirements = tables.requirements.map(interpretRequirement);
  const resources = tables.resources.map(interpretResource);
  const replies = tables.replies.map(interpretReply);
  const links = linkEvidence(resources, replies);
  const groups = buildGroupProfiles(requirements);

  return {
    requirements,
    resources,
    replies,
    links,
    groups,
    byId: Object.fromEntries([...requirements, ...resources, ...replies].map(r => [r.id, r])),
    evidenceFor(id) {
      const row = this.byId[id];
      return row?.evidence || [];
    }
  };
}

function replyClock(reply) {
  // Prefer an explicit clock in the sentence because it identifies a session.
  return parseClock(reply.text);
}

export function linkEvidence(resources, replies) {
  const links = [];
  for (const reply of replies) {
    const explicit = reply.target || reply.segmentId || reply.resourceId || reply.about;
    const targets = new Set();
    const reasons = [];

    if (explicit) {
      for (const id of Array.isArray(explicit) ? explicit : [explicit]) targets.add(id);
      reasons.push('explicit_target');
    }

    const mentionedTime = replyClock(reply);
    if (mentionedTime != null) {
      for (const r of resources) {
        if (parseClock(r.slot) === mentionedTime) {
          targets.add(r.id);
          reasons.push('same_slot');
        }
      }
    }

    for (const r of resources) {
      const placeMatch = reply.source && (reply.source === r.from || reply.source === r.to || reply.text.includes(r.to) || reply.text.includes(r.from));
      if (placeMatch) {
        targets.add(r.id);
        reasons.push('same_place');
      }
      if (/接驳方|小巴|shuttle|minibus|transport/i.test(reply.source + reply.text)
        && /接驳|shuttle|transport/i.test(r.type + r.text)) {
        targets.add(r.id);
        reasons.push('shuttle_semantic');
      }
      if (/讲解厅|展厅|hall|gallery|talk/i.test(reply.source + reply.text)
        && /讲解|活动|talk|activity/i.test(r.type + r.text)
        && (reply.text.includes(r.to) || reply.source.includes(r.to) || r.to.includes(reply.source))) {
        targets.add(r.id);
        reasons.push('hall_semantic');
      }
    }

    links.push({ replyId: reply.id, resourceIds: [...targets], reasons: [...new Set(reasons)] });
  }
  return links;
}

export function unionFind(items) {
  const parent = new Map(items.map(x => [x, x]));
  function find(x) {
    if (!parent.has(x)) parent.set(x, x);
    if (parent.get(x) !== x) parent.set(x, find(parent.get(x)));
    return parent.get(x);
  }
  function union(a, b) {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  function groups() {
    const map = new Map();
    for (const x of parent.keys()) {
      const root = find(x);
      if (!map.has(root)) map.set(root, []);
      map.get(root).push(x);
    }
    return [...map.values()];
  }
  return { find, union, groups };
}

export function companionClosure(input = []) {
  const pairs = [];
  const ids = new Set();
  const add = (a, b) => {
    if (!a || !b) return;
    ids.add(a); ids.add(b); pairs.push([a, b]);
  };

  for (const item of input) {
    if (Array.isArray(item)) {
      if (item.length === 2 && typeof item[0] === 'string' && typeof item[1] === 'string') add(item[0], item[1]);
      else if (item.length > 1) {
        ids.add(item[0]);
        for (let i = 1; i < item.length; i += 1) add(item[0], item[i]);
      }
    } else if (item && typeof item === 'object') {
      if (Array.isArray(item.subjects)) {
        for (let i = 0; i < item.subjects.length - 1; i += 1) add(item.subjects[i], item.subjects[i + 1]);
      } else if (item.a && item.b) add(item.a, item.b);
    }
  }

  const uf = unionFind([...ids]);
  pairs.forEach(([a, b]) => uf.union(a, b));
  return uf.groups().map(g => g.sort());
}

function mergeWheelchairProfile(constraints) {
  const wcs = constraints.filter(c => c.code === 'wheelchairs');
  if (wcs.length === 0) return null;
  const total = Math.max(...wcs.map(w => w.total || 0));
  const foldableKnown = wcs.find(w => Number.isInteger(w.foldable));
  const foldable = foldableKnown?.foldable ?? null;
  return {
    total,
    foldable,
    nonFoldable: foldable == null ? null : total - foldable,
    evidence: wcs.flatMap(w => w.evidence || [])
  };
}

export function buildGroupProfiles(requirements = []) {
  const byGroup = new Map();
  for (const req of requirements) {
    const name = req.group || req.id || '未命名团组';
    if (!byGroup.has(name)) {
      byGroup.set(name, {
        group: name,
        locales: [],
        requirementIds: [],
        constraints: [],
        relations: [],
        conditions: [],
        timeWindows: [],
        preferences: [],
        hardRequirements: []
      });
    }
    const g = byGroup.get(name);
    g.requirementIds.push(req.id);
    g.locales.push(req.locale);
    g.constraints.push(...req.constraints);
    g.relations.push(...req.relations);
    g.conditions.push(...(req.conditions || []));
    for (const c of req.constraints) {
      if (c.code === 'activity_window') g.timeWindows.push({ start: c.start, end: c.end, evidence: c.evidence });
      if (c.kind === 'preference') g.preferences.push(c.code);
      if (c.kind === 'hard') g.hardRequirements.push(c.code);
    }
  }

  return [...byGroup.values()].map(g => ({
    ...g,
    wheelchairs: mergeWheelchairProfile(g.constraints),
    companionGroups: companionClosure(g.relations),
    hasCompanionship: g.relations.length > 0
  }));
}

export function getGroupProfile(analysis, groupName) {
  if (!groupName) return analysis.groups[0] || null;
  return analysis.groups.find(g => g.group === groupName)
    || analysis.groups.find(g => g.group.includes(groupName) || groupName.includes(g.group))
    || null;
}
