import { companionClosure, unionFind } from './analysis.js';
import { analyzeMaterials } from './analysis.js';
import { planItineraries } from './planner.js';

let bookingSequence = 0;

function nextId(prefix) {
  bookingSequence += 1;
  return `${prefix}-${Date.now().toString(36)}-${bookingSequence}`;
}

function membersFromPlan(input = {}) {
  if (Array.isArray(input.members) && input.members.length) return input.members;
  if (Array.isArray(input.party) && input.party.length) return input.party;
  if (input.groupProfile?.companionGroups?.length) {
    return [...new Set(input.groupProfile.companionGroups.flat())];
  }
  return [];
}

export function basisSnapshot(analysis, segmentIds = []) {
  return segmentIds.map(segmentId => {
    const resource = analysis?.byId?.[segmentId] || { id: segmentId };
    const links = analysis?.links?.filter(l => l.resourceIds.includes(segmentId)) || [];
    const replyIds = new Set(links.flatMap(l => l.replyId));
    const replies = [...replyIds].map(id => analysis.byId[id]).filter(Boolean);
    return {
      segmentId,
      sourceText: resource.text ?? null,
      source: resource,
      linkedReplies: replies.map(r => ({ id: r.id, source: r.source, received: r.received, text: r.text, evidence: r.evidence })),
      evidence: [
        ...(resource.evidence || []),
        ...replies.flatMap(r => r.evidence || [])
      ]
    };
  });
}

export class BookingLedger {
  constructor(analysis, options = {}) {
    this.analysis = analysis;
    this.options = options;
    this.bookings = new Map();
    this.confirmations = new Map();
    this.audit = [];
  }

  createBooking(input = {}) {
    const plan = input.plan || input.assessment || input;
    const id = input.id || plan.bookingId || nextId('booking');
    const group = input.group || plan.group || this.options.group;
    const segmentIds = input.segmentIds || plan.resourceIds || [];
    const inferredSessionIds = segmentIds.filter(id => {
      const row = this.analysis?.byId?.[id];
      return row && /讲解|活动|session|talk|activity/i.test(`${row.type || ''} ${row.text || ''}`);
    });
    const sessionIds = input.sessionIds || plan.sessionIds || inferredSessionIds;
    const groupProfile = this.analysis?.groups?.find(g => g.group === group) || input.groupProfile;
    const members = input.members || membersFromPlan({ ...input, groupProfile });
    const companionGroups = input.companionGroups
      || plan.companionGroups
      || groupProfile?.companionGroups
      || companionClosure(input.relations || []);

    const reservations = input.reservations
      || buildDefaultReservations(id, segmentIds, sessionIds, members, companionGroups, this.analysis);

    const booking = {
      id,
      tourId: input.tourId || input.tour || 'current-tour',
      group,
      members,
      companionGroups,
      segmentIds,
      sessionIds,
      reservations,
      routeId: input.routeId || plan.id || `route:${segmentIds.join('>')}`,
      status: input.status || (plan.committable ? 'confirmed' : 'draft'),
      createdAt: input.createdAt || new Date().toISOString(),
      basis: input.basis || basisSnapshot(this.analysis, segmentIds),
      validArrangements: [],
      staleItems: [],
      history: [{ at: input.createdAt || new Date().toISOString(), type: 'created', status: input.status || (plan.committable ? 'confirmed' : 'draft') }]
    };
    this.bookings.set(id, booking);
    this.audit.push({ type: 'booking_created', bookingId: id });
    return booking;
  }

  // Record an actual confirmation. Confirmations are private to a tour/group and
  // are never treated as reusable by a new tour.
  confirmBooking(bookingId, confirmation = {}) {
    const booking = this.bookings.get(bookingId);
    if (!booking) throw new Error(`找不到预订单：${bookingId}`);
    const record = {
      id: confirmation.id || nextId('confirmation'),
      bookingId,
      tourId: confirmation.tourId || booking.tourId,
      group: booking.group,
      scope: confirmation.scope || { segmentIds: booking.segmentIds, sessionIds: booking.sessionIds },
      sourceId: confirmation.sourceId,
      received: confirmation.received,
      text: confirmation.text,
      at: confirmation.at || new Date().toISOString(),
      reusableByNewTour: false
    };
    this.confirmations.set(record.id, record);
    booking.confirmationIds = [...(booking.confirmationIds || []), record.id];
    booking.status = 'confirmed';
    booking.history.push({ at: record.at, type: 'confirmed', confirmationId: record.id, scope: record.scope });
    return record;
  }

  get(bookingId) {
    return this.bookings.get(bookingId);
  }

  listForGroup(group, options = {}) {
    return [...this.bookings.values()].filter(b => {
      if (b.group !== group) return false;
      if (options.tourId && b.tourId !== options.tourId) return false;
      return true;
    });
  }

  applyReply(reply) {
    const impact = correctionImpact([...this.bookings.values()], reply, this.analysis);
    for (const item of impact.bookingImpacts) {
      const booking = this.bookings.get(item.bookingId);
      booking.status = 'needs_reconfirmation';
      booking.staleItems = unique([...(booking.staleItems || []), ...item.needsReconfirmation]);
      booking.history.push({
        at: reply.received || new Date().toISOString(),
        type: 'correction_received',
        replyId: reply.id,
        needsReconfirmation: item.needsReconfirmation,
        stillValid: item.stillValid
      });
    }
    this.audit.push({ type: 'reply_applied', replyId: reply.id });
    return impact;
  }

  changeCompanions(bookingId, change) {
    const booking = this.bookings.get(bookingId);
    if (!booking) throw new Error(`找不到预订单：${bookingId}`);
    const impact = companionChangeImpact(booking, change);
    booking.companionGroups = impact.nextCompanionGroups;
    booking.members = unique([...booking.members, ...impact.affectedMembers]);
    booking.status = 'needs_reconfirmation';
    booking.staleItems = unique([...(booking.staleItems || []), ...impact.affectedReservationIds]);
    booking.history.push({ at: new Date().toISOString(), type: 'companions_changed', ...change, impact });
    return impact;
  }

  copyForNewTour(bookingId, newTourId, newGroup = null) {
    const old = this.bookings.get(bookingId);
    if (!old) throw new Error(`找不到预订单：${bookingId}`);
    const copy = this.createBooking({
      tourId: newTourId,
      group: newGroup || old.group,
      segmentIds: old.segmentIds,
      sessionIds: old.sessionIds,
      members: old.members,
      companionGroups: old.companionGroups,
      routeId: old.routeId,
      status: 'needs_reconfirmation'
    });
    copy.priorBookingId = old.id;
    copy.confirmationIds = [];
    copy.staleItems = [...old.segmentIds];
    copy.reusedOldConfirmations = false;
    copy.history.push({
      at: new Date().toISOString(),
      type: 'new_tour_requires_fresh_confirmations',
      priorBookingId: old.id,
      message: '旧团确认只作历史依据；新团不得复用旧预约/场次确认。'
    });
    return copy;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function reservationParties(members = [], companionGroups = []) {
  const grouped = new Set(companionGroups.flat());
  const singleton = members.filter(m => !grouped.has(m)).map(m => [m]);
  const parties = companionGroups.length ? [...companionGroups, ...singleton] : [members];
  return parties.filter(party => party.length);
}

export function buildDefaultReservations(bookingId, segmentIds, sessionIds, members, companionGroups, analysis = null) {
  const parties = reservationParties(members, companionGroups);
  return parties.flatMap((party, partyIndex) => segmentIds.map(segmentId => ({
    id: `res:${bookingId}:${partyIndex}:${segmentId}`,
    kind: analysis?.byId?.[segmentId]?.type || 'segment',
    segmentId,
    sessionId: sessionIds.includes(segmentId) ? segmentId : undefined,
    partyIds: party,
    status: 'held'
  })));
}

export function correctionImpact(bookings = [], reply, analysis = null) {
  const interpreted = reply?.claims || reply?.text ? reply : analyzeMaterials({ replies: [reply] }).replies[0];
  let affectedResourceIds = new Set(reply.target || reply.segmentIds || []);

  if (analysis?.resources) {
    const links = analysis.links?.find(l => l.replyId === reply.id);
    if (links) links.resourceIds.forEach(id => affectedResourceIds.add(id));
    if (affectedResourceIds.size === 0) {
      const fresh = analyzeMaterials({ replies: [reply], resources: analysis.resources.map(r => ({ ...r })) });
      fresh.links.find(l => l.replyId === reply.id)?.resourceIds.forEach(id => affectedResourceIds.add(id));
    }
  }

  // Without a linked graph, semantically scope a shuttle correction using the
  // booking's stored basis rather than invalidating arbitrary records.
  if (affectedResourceIds.size === 0 && /小巴|接駁|接驳|shuttle|minibus/iu.test(reply.text || '')) {
    for (const b of bookings) {
      for (const item of b.basis || []) {
        if (/接驳|接駁|shuttle|transport/i.test(`${item.source?.type || ''} ${item.sourceText || ''}`)) {
          affectedResourceIds.add(item.segmentId);
        }
      }
      for (const id of b.segmentIds?.filter(id => /^s\d+/.test(id)) || []) affectedResourceIds.add(id);
    }
  }

  const bookingImpacts = [];
  for (const booking of bookings) {
    const direct = booking.segmentIds.filter(id => affectedResourceIds.has(id));
    if (direct.length === 0) continue;

    const staleBasis = (booking.basis || []).filter(b => direct.includes(b.segmentId));
    const stillValid = booking.segmentIds.filter(id => !direct.includes(id));
    const directlyAffectedSessions = (booking.sessionIds || []).filter(id => direct.includes(id));
    const tiedSessions = new Set(directlyAffectedSessions);
    // A directly affected travel leg only forces another session when an
    // explicit rebook/connection rule says the inventory is bundled.
    for (const res of booking.reservations || []) {
      if (direct.includes(res.segmentId) && res.mustRebookSession) tiedSessions.add(res.sessionId);
    }

    bookingImpacts.push({
      bookingId: booking.id,
      group: booking.group,
      routeId: booking.routeId || null,
      affectedRouteIds: booking.routeId ? [booking.routeId] : [],
      affectedSegments: direct,
      affectedSessionIds: [...tiedSessions],
      needsReconfirmation: unique([...direct, ...tiedSessions]),
      directlyAffected: direct,
      directlyAffectedSessions,
      conditionallyTiedSessions: [...tiedSessions].filter(id => !directlyAffectedSessions.includes(id)),
      staleJudgmentBasis: staleBasis,
      originalBasis: staleBasis,
      stillValid,
      unaffectedSessionIds: (booking.sessionIds || []).filter(id => !tiedSessions.has(id)),
      validArrangements: stillValid.map(id => ({ segmentId: id, basis: (booking.basis || []).find(b => b.segmentId === id) })),
      replyEvidence: interpreted.evidence || [],
      currentReply: { id: reply.id, source: reply.source, received: reply.received, text: reply.text }
    });
  }

  return {
    replyId: reply.id,
    affectedResourceIds: [...affectedResourceIds],
    bookingImpacts,
    affectedBookingIds: bookingImpacts.map(b => b.bookingId),
    affectedRouteIds: unique(bookingImpacts.flatMap(b => b.affectedRouteIds)),
    affectedSessionIds: unique(bookingImpacts.flatMap(b => b.affectedSessionIds)),
    unaffectedSessionIds: unique(bookingImpacts.flatMap(b => b.unaffectedSessionIds)),
    // Convenience flat fields for small scripts/tests.
    needsReconfirmation: unique(bookingImpacts.flatMap(b => b.needsReconfirmation)),
    stillValid: unique(bookingImpacts.flatMap(b => b.stillValid))
  };
}

function groupsFromSpec(spec, members) {
  if (!spec) return companionClosure([]);
  if (Array.isArray(spec)) return companionClosure(spec);
  if (Array.isArray(spec.companionGroups)) return companionClosure(spec.companionGroups);
  if (Array.isArray(spec.relations)) return companionClosure(spec.relations);
  if (Array.isArray(spec.add) || Array.isArray(spec.remove)) {
    // Applied by caller through old + ops.
    return null;
  }
  return companionClosure([]);
}

export function companionChangeImpact(bookingOrPlan = {}, change = {}) {
  const oldGroups = bookingOrPlan.companionGroups?.length
    ? companionClosure(bookingOrPlan.companionGroups)
    : companionClosure(bookingOrPlan.relations || []);
  const members = unique([
    ...(bookingOrPlan.members || []),
    ...oldGroups.flat(),
    ...(change.members || [])
  ]);

  let nextGroups;
  if (change.nextCompanionGroups || change.companionGroups || change.relations) {
    nextGroups = groupsFromSpec(change.nextCompanionGroups || change.companionGroups || change.relations, members);
  } else {
    const uf = unionFind(members);
    oldGroups.forEach(g => {
      for (let i = 1; i < g.length; i += 1) uf.union(g[0], g[i]);
    });
    for (const pair of change.remove || change.removeRelations || []) {
      // unionFind has no split; rebuild from all old pairs except removed.
    }
    const removed = new Set((change.remove || change.removeRelations || []).map(p => [...p].sort().join('|')));
    const pairs = [];
    for (const g of oldGroups) {
      for (let i = 0; i < g.length; i += 1) {
        for (let j = i + 1; j < g.length; j += 1) {
          const key = [g[i], g[j]].sort().join('|');
          if (!removed.has(key)) pairs.push([g[i], g[j]]);
        }
      }
    }
    for (const pair of change.add || change.addRelations || []) pairs.push(pair);
    nextGroups = companionClosure(pairs);
  }

  const oldKey = new Set(oldGroups.map(g => g.slice().sort().join('|')));
  const newKey = new Set(nextGroups.map(g => g.slice().sort().join('|')));
  const changedGroups = [
    ...oldGroups.filter(g => !newKey.has(g.slice().sort().join('|'))),
    ...nextGroups.filter(g => !oldKey.has(g.slice().sort().join('|')))
  ];
  const affectedMembers = unique([
    ...(change.members || []),
    ...(change.endpoints || []).flat?.() || [],
    ...changedGroups.flat()
  ]);

  const segmentIds = bookingOrPlan.segmentIds || bookingOrPlan.resourceIds || [];
  const reservations = bookingOrPlan.reservations
    || buildDefaultReservations(bookingOrPlan.id || 'plan', segmentIds, bookingOrPlan.sessionIds || [], members, oldGroups);

  const affectedReservationIds = new Set();
  for (const res of reservations) {
    const party = res.partyIds?.length ? res.partyIds : members;
    if (affectedMembers.some(m => party.includes(m))) affectedReservationIds.add(res.id);
  }

  // Follow explicit rebook-with edges and same-party chain reservations.
  let grew = true;
  while (grew) {
    grew = false;
    for (const res of reservations) {
      if (affectedReservationIds.has(res.id)) {
        for (const linkedId of res.rebookWith || []) {
          if (!affectedReservationIds.has(linkedId)) {
            affectedReservationIds.add(linkedId);
            grew = true;
          }
        }
      } else if ((res.partyIds || []).some(m => affectedMembers.includes(m))) {
        affectedReservationIds.add(res.id);
        grew = true;
      }
    }
  }

  const affected = reservations.filter(r => affectedReservationIds.has(r.id));
  const unaffected = reservations.filter(r => !affectedReservationIds.has(r.id));
  const affectedSegmentIds = unique(affected.map(r => r.segmentId).filter(Boolean));
  const affectedSessionIds = unique(affected.map(r => r.sessionId).filter(Boolean));

  return {
    oldCompanionGroups: oldGroups,
    nextCompanionGroups: nextGroups,
    changedCompanionGroups: changedGroups,
    affectedMembers,
    affectedReservationIds: [...affectedReservationIds],
    affectedRouteIds: affectedSegmentIds,
    affectedSegmentIds,
    affectedSessionIds,
    rebookTogether: affected.map(r => r.id),
    unaffectedReservationIds: unaffected.map(r => r.id),
    canStaggerUnrelatedGroups: true,
    rule: '同一同行组必须共享交通段和场次；无同行关系的两组才可错开讲解厅。'
  };
}

export function validateAssignment(assignment = {}) {
  const companionGroups = assignment.companionGroups || companionClosure(assignment.relations || []);
  const items = assignment.assignments || assignment.items || [];
  const errors = [];

  for (const group of companionGroups) {
    const memberSet = new Set(group);
    const mine = items.filter(i => (i.memberIds || i.members || []).some(m => memberSet.has(m)));
    const byLeg = new Map();
    for (const item of mine) {
      const legKey = item.legId || item.segmentId || item.transportId || 'default';
      if (!byLeg.has(legKey)) byLeg.set(legKey, new Set());
      for (const m of item.memberIds || item.members || []) byLeg.get(legKey).add(m);
    }
    for (const [legId, set] of byLeg) {
      const represented = group.filter(m => set.has(m));
      if (represented.length > 0 && represented.length < group.length) {
        errors.push({ code: 'companions_split_on_leg', legId, companionGroup: group, represented });
      }
    }
    const sessions = unique(mine.map(i => i.sessionId).filter(Boolean));
    if (sessions.length > 1) {
      errors.push({ code: 'companions_split_sessions', sessions, companionGroup: group });
    }
  }
  return { ok: errors.length === 0, errors };
}

// Return-trip wording is interpreted independently. An outbound conclusion is
// copied only when the return text expressly says the same scope applies.
export function assessReturnTrip(outboundAssessment, returnRecord, analysis = null) {
  const row = typeof returnRecord === 'string' ? { id: 'return', text: returnRecord } : returnRecord;
  const sameScope = /同去程|與去程相同|与去程相同|去程[^。；;]{0,12}返程[^。；;]{0,8}(?:相同|一樣|一样)|返程[^。；;]{0,12}(?:同|相同)|same\s+(?:as\s+)?outbound|same\s+conditions|both\s+directions/iu.test(row.text || '');
  const assessed = analysis ? planItineraries(analysis) : null;
  return {
    returnId: row.id,
    copiedFromOutbound: false,
    mayCopyOutbound: sameScope,
    status: sameScope ? 'same_scope_stated' : 'needs_confirmation',
    outboundStatus: outboundAssessment?.status || null,
    message: sameScope
      ? '返程文本明确声明适用相同条件，可在核对日期/场次后沿用对应判断。'
      : '返程描述不足以证明适用去程条件；已独立列为待确认，不照搬去程结论。',
    record: row
  };
}

export function createTourSystem(materials) {
  const analysis = analyzeMaterials(materials);
  const ledger = new BookingLedger(analysis);
  return {
    analysis,
    ledger,
    plan: (options = {}) => planItineraries(analysis, options),
    book: input => ledger.createBooking(input),
    applyReply: reply => ledger.applyReply(reply),
    changeCompanions: (...args) => ledger.changeCompanions(...args),
    brief: async (group, options) => {
      const { buildGuideBrief } = await import('./brief.js');
      return buildGuideBrief(analysis, ledger, group, options);
    }
  };
}
