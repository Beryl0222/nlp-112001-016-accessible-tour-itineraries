import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMaterials } from '../materials.js';
import { parseNeeds } from '../src/needs.js';
import { parseSegments } from '../src/segments.js';
import { parseReplies, applyCorrections } from '../src/replies.js';
import { assessSegment } from '../src/assessment.js';
import { TourLedger } from '../src/ledger.js';
import { affectedOnly, explainForParent, briefingForGuide } from '../src/explanations.js';
import { evaluateRoutesForGroup } from '../src/itinerary.js';

const load = async () => {
  const tables = await readMaterials();
  const needs = parseNeeds(tables['需求.json']);
  const { segments, byId } = parseSegments(tables['资源.json']);
  const replies = parseReplies(tables['接待回复.json'], byId);
  applyCorrections(segments, replies);
  return { needs, segments, byId, replies };
};

test('外部更正只影响真正相关的路段，并保留原判断依据与仍有效安排', async () => {
  const { needs, segments, replies } = await load();
  const ledger = new TourLedger();
  const tourId = TourLedger.createTourId();
  const groupNeeds = needs.groups.get('低年级同行组');

  for (const id of ['s1', 's2', 's3', 's4']) {
    ledger.recordConfirmation(tourId, '低年级同行组', id,
      assessSegment('低年级同行组', groupNeeds, segments.find(s => s.id === id), replies));
  }

  const v2 = replies.find(r => r.id === 'v2');
  const affected = ledger.applyExternalCorrection(tourId, v2, ['s3'], ['s1', 's2', 's4']);
  assert.deepEqual(affected.map(e => e.segmentId), ['s3']);
  assert.equal(affected[0].state, 'reconfirm-required');
  assert.equal(affected[0].supersededBy, 'v2');
  assert.match(affected[0].note, /仍有效安排：s1、s2、s4/);

  // 其他路段状态不被本次更正改动（s4 已确认；s1/s2 本就待确认，但与 v2 无关）
  const others = ledger.forTour(tourId).filter(e => e.segmentId !== 's3');
  assert.ok(others.every(e => e.supersededBy !== 'v2'));
  assert.equal(ledger.traceDecision(tourId, '低年级同行组', 's4').state, 'confirmed');
});

test('部分成员改变同行约定：必须一同重约的交通段与场次级联失效', async () => {
  const { needs, segments, replies } = await load();
  const ledger = new TourLedger();
  const tourId = TourLedger.createTourId();
  const groupNeeds = needs.groups.get('低年级同行组');
  for (const id of ['s1', 's2', 's4']) {
    ledger.recordConfirmation(tourId, '低年级同行组', id,
      assessSegment('低年级同行组', groupNeeds, segments.find(s => s.id === id), replies));
  }

  // 变更只牵涉 s1→s2 这条共同约定；s4 属于另一条路线，不应被波及
  const invalidated = ledger.cascadeCompanionChange(tourId, 'change-001', ['s1', 's2']);
  assert.deepEqual(invalidated.map(e => e.segmentId).sort(), ['s1', 's2']);
  assert.equal(ledger.traceDecision(tourId, '低年级同行组', 's4').state, 'confirmed');
  for (const id of ['s1', 's2']) {
    assert.equal(ledger.traceDecision(tourId, '低年级同行组', id).supersededBy, 'change-001');
  }
});

test('团方缩小需求后只重评受影响路段，其余确认原样保留', async () => {
  const { segments, replies } = await load();
  const ledger = new TourLedger();
  const tourId = TourLedger.createTourId();
  // 缩窄后的需求：不再携带非折叠轮椅（团方接受只带可折叠型）
  const narrowed = parseNeeds([
    { id: 'r1b', group: '低年级同行组', locale: 'zh-HK', text: '一部可折叠轮椅。' }
  ]).all;
  const original = parseNeeds([
    { id: 'r1', group: '低年级同行组', locale: 'zh-HK', text: '两部轮椅只有一部摺得埋。' }
  ]).all;

  ledger.recordConfirmation(tourId, '低年级同行组', 's3',
    assessSegment('低年级同行组', original, segments.find(s => s.id === 's3'), replies));
  ledger.recordConfirmation(tourId, '低年级同行组', 's4',
    assessSegment('低年级同行组', original, segments.find(s => s.id === 's4'), replies));

  const { reconfirmed, untouched } = ledger.narrowAndReassess(
    tourId, '低年级同行组', narrowed, segments, replies, ['s3']);
  assert.deepEqual(reconfirmed.map(e => e.segmentId), ['s3']);
  assert.deepEqual(untouched.map(e => e.segmentId), ['s4']);
});

test('新团不能复用旧确认：不同 tourId 的台账互相隔离', async () => {
  const { needs, segments, replies } = await load();
  const ledger = new TourLedger();
  const tourA = TourLedger.createTourId('A');
  const tourB = TourLedger.createTourId('B');
  ledger.recordConfirmation(tourA, '低年级同行组', 's4',
    assessSegment('低年级同行组', needs.groups.get('低年级同行组'), segments.find(s => s.id === 's4'), replies));

  assert.equal(ledger.forTour(tourB).length, 0);
  assert.equal(ledger.briefingFor(tourB).length, 0);
  assert.equal(ledger.traceDecision(tourB, '低年级同行组', 's4'), null);
  assert.throws(() => ledger.applyExternalCorrection(tourB, replies[0], ['s4']), /新团不能复用旧确认/);
  // A 团的数据不受影响
  assert.equal(ledger.forTour(tourA).length, 1);
});

test('导游按团领取说明并可复现决定依据原文', async () => {
  const { needs, segments, replies } = await load();
  const ledger = new TourLedger();
  const tourId = TourLedger.createTourId();
  ledger.recordConfirmation(tourId, '家长观察组', 's4',
    assessSegment('家长观察组', needs.groups.get('家长观察组'), segments.find(s => s.id === 's4'), replies));
  const text = briefingForGuide(ledger, tourId);
  assert.match(text, /s4/);
  assert.match(text, /十四点十五接待时段仍有席位/); // v1 原句可复现
  const trace = ledger.traceDecision(tourId, '家长观察组', 's4');
  assert.equal(trace.state, 'confirmed');
  assert.match(trace.originalBasis, /v1/);
});

test('接单人员只看到真正受影响的路线和场次', async () => {
  const { needs, segments, replies } = await load();
  const evaluations = evaluateRoutesForGroup('低年级同行组',
    needs.groups.get('低年级同行组'), segments, replies);
  const hit = affectedOnly(evaluations, ['s3']);
  assert.equal(hit.length, 1);
  assert.deepEqual(hit[0].route, ['s3', 's4']);
  assert.deepEqual(hit[0].blocked, ['s3']);
});

test('家长说明保留粤语/英文原句，并明确指出不确定与舍弃的偏好', async () => {
  const { needs, segments, replies } = await load();
  const evaluations = evaluateRoutesForGroup('家长观察组',
    needs.groups.get('家长观察组'), segments, replies);
  const text = explainForParent('家长观察组', evaluations);
  assert.match(text, /lift would be preferable/); // 英文原句不翻译
  assert.match(text, /尚不确定|可以承诺|路线不能成立/);

  const lowerText = explainForParent('低年级同行组',
    evaluateRoutesForGroup('低年级同行组', needs.groups.get('低年级同行组'), segments, replies));
  assert.match(lowerText, /雨天停行/);   // 粤语书面词原样保留
  assert.match(lowerText, /须提前安排/);
  assert.match(lowerText, /仅指可折叠轮椅|无法载不能折叠/);
});
