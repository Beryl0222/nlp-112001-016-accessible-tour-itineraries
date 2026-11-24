import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMaterials } from '../materials.js';
import { analyzeMaterials } from '../analysis.js';
import { planItineraries } from '../planner.js';
import {
  BookingLedger,
  assessReturnTrip,
  companionChangeImpact,
  validateAssignment
} from '../ledger.js';
import { createService } from '../api.js';
import { parseText } from '../api.js';
import { scheduleCompanionUnits } from '../scheduler.js';

const materials = await readMaterials();
const analysis = analyzeMaterials(materials);

test('多语需求被解析并保留原文定位', () => {
  const group = analysis.groups.find(g => g.group === '低年级同行组');
  assert.deepEqual(group.wheelchairs.total, 2);
  assert.deepEqual(group.wheelchairs.foldable, 1);
  assert.deepEqual(group.wheelchairs.nonFoldable, 1);
  assert.deepEqual(group.companionGroups, [['children', 'leadTeacher']]);
  assert.equal(group.timeWindows[0].start, 13 * 60);
  assert.equal(group.timeWindows[0].end, 15 * 60);

  const ev = group.wheelchairs.evidence[0];
  assert.equal(ev.recordId, 'r1');
  assert.equal(ev.quote, '两部轮椅');
  assert.match(ev.locator, /^r1#text\[\d+:\d+\]$/);
  assert.ok(ev.sentence.includes('摺得埋'));

  const english = parseText('A short walk is fine, but we cannot be separated from Ms Lee.', { id: 'en' });
  assert.ok(english.tags.includes('short_walk'));
  assert.ok(english.relations.some(r => /must_not_separate|must_stay_together/.test(r.type)));
});

test('样本路线区分可承诺、待确认和明确不可行', () => {
  const result = planItineraries(analysis, { group: '低年级同行组' });
  const north = result.plans.find(p => p.id === 'route:s1>s2');
  const west = result.plans.find(p => p.id === 'route:s3>s4');

  assert.equal(north.status, 'needs_confirmation');
  assert.ok(north.issues.some(i => i.code === 'wheelchair_step_access_unconfirmed'));
  assert.ok(north.issues.some(i => i.code === 'weather_condition_unconfirmed'));
  assert.equal(north.committable, false);

  assert.equal(west.status, 'unavailable');
  assert.ok(west.issues.some(i => i.code === 'non_foldable_wheelchair_denied'));

  assert.ok(result.brokenConnections.some(b => b.resourceIds.join('>') === 's5>s1'));
  assert.ok(result.brokenConnections[0].issues?.some?.(i => i.code === 'time_conflict') || result.brokenConnections.some(b => b.message.includes('无法接上')));
});

test('家长组在天气确认后可承诺北门路线，升降机只作为舍弃偏好', () => {
  const result = planItineraries(analysis, { group: '家长观察组', weather: 'dry' });
  const north = result.plans.find(p => p.id === 'route:s1>s2');
  assert.equal(north.status, 'committable');
  assert.equal(north.sacrificedPreferences[0]?.code, 'lift');
});

test('接驳澄清只使 s3 失效，s4 接待依据仍有效', () => {
  const before = analyzeMaterials({
    ...materials,
    '接待回复.json': materials['接待回复.json'].filter(r => r.id !== 'v2')
  });
  const ledger = new BookingLedger(before);
  ledger.createBooking({
    id: 'b1',
    group: '低年级同行组',
    segmentIds: ['s3', 's4'],
    sessionIds: ['s4'],
    status: 'confirmed'
  });
  const v2 = materials['接待回复.json'].find(r => r.id === 'v2');
  const impact = ledger.applyReply(v2);
  assert.deepEqual(impact.affectedResourceIds, ['s3']);
  assert.deepEqual(impact.needsReconfirmation, ['s3']);
  assert.deepEqual(impact.stillValid, ['s4']);
  const booking = ledger.get('b1');
  assert.equal(booking.status, 'needs_reconfirmation');
  assert.deepEqual(booking.staleItems, ['s3']);
  assert.ok(booking.history.some(h => h.type === 'correction_received'));
});

test('部分同行约定改变时只传播到对应同行组的交通段和场次', () => {
  const plan = {
    id: 'p',
    members: ['a', 'teacher-a', 'b', 'teacher-b'],
    companionGroups: [['a', 'teacher-a'], ['b', 'teacher-b']],
    segmentIds: ['bus-1', 'hall-1'],
    sessionIds: ['hall-1'],
    reservations: [
      { id: 'r-bus-a', segmentId: 'bus-1', partyIds: ['a', 'teacher-a'] },
      { id: 'r-hall-a', segmentId: 'hall-1', sessionId: 'hall-1', partyIds: ['a', 'teacher-a'] },
      { id: 'r-bus-b', segmentId: 'bus-1', partyIds: ['b', 'teacher-b'] },
      { id: 'r-hall-b', segmentId: 'hall-1', sessionId: 'hall-1', partyIds: ['b', 'teacher-b'] }
    ]
  };
  const impact = companionChangeImpact(plan, {
    members: ['a'],
    remove: [['a', 'teacher-a']],
    add: [['a', 'parent-a']]
  });
  assert.ok(impact.affectedReservationIds.includes('r-bus-a'));
  assert.ok(impact.affectedReservationIds.includes('r-hall-a'));
  assert.ok(!impact.affectedReservationIds.includes('r-bus-b'));
  assert.ok(!impact.affectedReservationIds.includes('r-hall-b'));
  assert.ok(impact.affectedSessionIds.includes('hall-1'));

  const valid = validateAssignment({
    companionGroups: [['a', 'parent-a']],
    assignments: [
      { memberIds: ['a', 'parent-a'], legId: 'bus-2', sessionId: 'hall-2' }
    ]
  });
  assert.equal(valid.ok, true);

  const invalid = validateAssignment({
    companionGroups: [['a', 'teacher-a']],
    assignments: [
      { memberIds: ['a'], legId: 'bus-1', sessionId: 'hall-1' },
      { memberIds: ['teacher-a'], legId: 'bus-2', sessionId: 'hall-2' }
    ]
  });
  assert.equal(invalid.ok, false);
  assert.ok(invalid.errors.some(e => e.code === 'companions_split_sessions'));
});

test('返程不会照搬去程判断，除非明确写明相同条件', () => {
  const independent = assessReturnTrip({ status: 'committable' }, { id: 'rt', text: '回程班次另行通知，轮椅安排待确认。' });
  assert.equal(independent.copiedFromOutbound, false);
  assert.equal(independent.status, 'needs_confirmation');

  const same = assessReturnTrip({ status: 'committable' }, { id: 'rt2', text: '返程适用与去程相同的无障碍条件。' });
  assert.equal(same.mayCopyOutbound, true);
});

test('笼统 accessible 宣传和宽度条件不能确认硬性需求', () => {
  const service = createService({
    '需求.json': [{ id: 'x', group: 'G', locale: 'en', text: 'We have one non-foldable wheelchair.' }],
    '资源.json': [
      { id: 'e1', type: '入口', from: 'Gate', to: 'Lobby', slot: '10:00', text: 'The venue is accessible and barrier-free.' },
      { id: 'v1', type: '接驳', from: 'Gate', to: 'Hall', slot: '10:20', text: 'Boarding depends on wheelchair width.' },
      { id: 'h1', type: '讲解', from: 'Hall', to: 'Hall', slot: '10:40', text: 'Whole group reception.' }
    ],
    '接待回复.json': []
  });
  const result = service.plan({ group: 'G' });
  const entrance = result.segmentAssessments.find(s => s.segmentId === 'e1');
  assert.ok(entrance.issues.some(i => i.code === 'generic_accessibility_unverified'));
  const shuttle = result.segmentAssessments.find(s => s.segmentId === 'v1');
  assert.ok(shuttle.issues.some(i => i.code === 'shuttle_width_unconfirmed'));
});

test('不同同行组可错开场次，但调度单位内部不拆分', () => {
  const result = scheduleCompanionUnits({
    stagger: true,
    units: [
      { id: 'u1', members: ['a', 'teacher-a'] },
      { id: 'u2', members: ['b', 'teacher-b'] }
    ],
    sessions: [
      { id: 'hall-1325', slot: '13:25', capacityGroups: 1 },
      { id: 'hall-1415', slot: '14:15', capacityGroups: 1 }
    ]
  });
  assert.equal(result.ok, true);
  assert.equal(new Set(result.assignments.map(a => a.sessionId)).size, 2);
  assert.deepEqual(result.assignments.find(a => a.unitId === 'u1').memberIds, ['a', 'teacher-a']);
});

test('新团复制旧路线时不得携带旧确认', () => {
  const service = createService(materials);
  service.book({ id: 'old-tour-booking', tourId: 'T1', group: '低年级同行组', segmentIds: ['s3', 's4'] });
  service.confirm('old-tour-booking', { id: 'old-c', tourId: 'T1', text: 'confirmed' });
  const copy = service.copyForNewTour('old-tour-booking', 'T2-NEW');
  assert.equal(copy.tourId, 'T2-NEW');
  assert.deepEqual(copy.confirmationIds, []);
  assert.ok(copy.staleItems.includes('s3'));
  assert.ok(copy.staleItems.includes('s4'));
});

test('导游说明可复现原文，旧确认不能被新团复用', () => {
  const service = createService(materials);
  service.book({ id: 'old', tourId: 'T1', group: '低年级同行组', segmentIds: ['s3', 's4'] });
  service.confirm('old', { id: 'c1', tourId: 'T1', group: '低年级同行组', text: 'confirmed' });
  const brief = service.brief('低年级同行组');
  assert.match(brief.markdown, /两部轮椅/);
  assert.match(brief.markdown, /r1#text/);
  assert.ok(brief.sources.some(s => s.id === 'v2'));

  const oldConfirmation = service.ledger.confirmations.get('c1');
  assert.equal(oldConfirmation.reusableByNewTour, false);
});
