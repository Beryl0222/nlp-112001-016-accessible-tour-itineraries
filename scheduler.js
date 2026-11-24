import { companionClosure } from './analysis.js';

// Schedule independent companion units. Members of one companion group are
// never split; different companion groups may be staggered into different
// sessions when capacity or a hall conflict makes same-session booking unsafe.
export function scheduleCompanionUnits(input = {}) {
  const units = normalizeUnits(input.units || input.groups || input.companionGroups || []);
  const sessions = (input.sessions || []).map(normalizeSession).sort((a, b) => (a.slotMinutes ?? 0) - (b.slotMinutes ?? 0));
  const assignments = [];
  const remainingCapacity = new Map(sessions.map(s => [s.id, s.capacityGroups]));
  const assignedCount = new Map(sessions.map(s => [s.id, 0]));
  const errors = [];

  for (const unit of units) {
    let compatible = sessions
      .filter(s => !s.location || !unit.location || s.location === unit.location)
      .filter(s => (remainingCapacity.get(s.id) ?? 1) > 0)
      .filter(s => !unit.earliest || s.slotMinutes >= unit.earliest)
      .filter(s => !unit.latest || s.slotMinutes <= unit.latest);

    if (input.stagger) {
      compatible = compatible.sort((a, b) =>
        (assignedCount.get(a.id) - assignedCount.get(b.id))
        || (a.slotMinutes ?? 0) - (b.slotMinutes ?? 0)
      );
    }
    const chosen = compatible[0];
    if (!chosen) {
      errors.push({ code: 'no_session_keeps_companions_together', unit: unit.id, members: unit.members });
      continue;
    }
    remainingCapacity.set(chosen.id, (remainingCapacity.get(chosen.id) ?? 1) - 1);
    assignedCount.set(chosen.id, (assignedCount.get(chosen.id) ?? 0) + 1);
    assignments.push({
      unitId: unit.id,
      memberIds: unit.members,
      sessionId: chosen.id,
      legId: unit.legId || chosen.legId,
      staggered: false
    });
  }

  const firstSession = assignments[0]?.sessionId;
  for (const assignment of assignments) assignment.staggered = assignment.sessionId !== firstSession;

  return {
    ok: errors.length === 0,
    assignments,
    errors,
    rule: '同一同行组必须同交通段、同场次；不同同行组可错开讲解厅。'
  };
}

function normalizeUnits(units) {
  return units.map((u, i) => {
    if (Array.isArray(u)) return { id: `unit-${i + 1}`, members: u };
    if (u.members || u.memberIds) return { id: u.id || `unit-${i + 1}`, members: u.members || u.memberIds, ...u };
    return { id: u.id || `unit-${i + 1}`, members: companionClosure(u.companionGroups || []) };
  });
}

function normalizeSession(s) {
  const slot = s.slotMinutes ?? parseMaybeClock(s.slot);
  return {
    id: s.id,
    location: s.location || s.to,
    slot: s.slot,
    slotMinutes: slot,
    capacityGroups: s.capacityGroups ?? s.groupCapacity ?? 1,
    legId: s.legId
  };
}

function parseMaybeClock(value) {
  if (value == null) return null;
  if (Number.isInteger(value)) return value;
  const m = String(value).match(/(\d{1,2}):(\d{2})/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
