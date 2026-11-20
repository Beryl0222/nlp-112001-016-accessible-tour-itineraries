import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNeeds } from '../src/needs.js';
import { parseSegments } from '../src/segments.js';
import { parseReplies, applyCorrections } from '../src/replies.js';
import { assessSegment } from '../src/assessment.js';

const lowerGradeNeeds = () => parseNeeds([
  { id: 'r1', group: 'G', locale: 'zh-HK', text: '两部轮椅只有一部摺得埋。小朋友一定要同带队老师一齐去。' },
  { id: 'r2', group: 'G', locale: 'zh', text: '能短距离步行，有台阶要有扶手。讲解想在下午一点到三点开始。' }
]).all;

const build = rows => parseSegments(rows).segments;

test('硬性需求无法确认时判 uncertain，宣传文案不能代替确认', () => {
  const segments = build([
    { id: 's2', type: '讲解', from: '小展厅', to: '小展厅', slot: '13:25', text: '接受两部轮椅。全团同场时须提前安排。' }
  ]);
  const result = assessSegment('G', lowerGradeNeeds(), segments[0], []);
  assert.equal(result.status, 'uncertain');
  const unknown = result.findings.find(f => f.status === 'unknown' && f.needKind === 'wheelchair-fleet');
  assert.ok(unknown);
  assert.match(unknown.message, /宣传文案不能代替确认/);
  assert.deepEqual(unknown.basis.map(b => b.record), ['r1', 's2']);
});

test('更正后只接可折叠轮椅：有非折叠轮椅的组判 blocked，并引用更正原句', () => {
  const segments = build([
    { id: 's3', type: '接驳', from: '西门', to: '大展厅', slot: '13:35', text: '小巴可载轮椅，下午直达。' }
  ]);
  const replies = parseReplies([
    { id: 'v2', source: '接驳方', received: '12:50', text: '小巴原说明仅指可折叠轮椅，无法载不能折叠的那部。' }
  ], new Map(segments.map(s => [s.id, s])));
  applyCorrections(segments, replies);
  const result = assessSegment('G', lowerGradeNeeds(), segments[0], replies);
  assert.equal(result.status, 'blocked');
  const blocked = result.findings.find(f => f.status === 'blocked');
  assert.equal(blocked.basis.some(b => b.record === 'v2'), true);
  assert.match(blocked.basis.find(b => b.record === 'v2').quote, /仅指可折叠轮椅/);
});

test('台阶有扶手且无台阶两种情形都判 met；无扶手判 blocked', () => {
  const needs = lowerGradeNeeds();
  const withRails = build([{ id: 's1', type: '步行', from: '北门', to: '小展厅', slot: '13:00', text: '经三阶，都有扶手。' }]);
  assert.equal(assessSegment('G', needs, withRails[0], []).findings
    .find(f => f.needKind === 'steps-with-rails').status, 'met');

  const noSteps = build([{ id: 's4', type: '讲解', from: '大展厅', to: '大展厅', slot: '14:15', text: '展厅内无台阶。' }]);
  assert.equal(assessSegment('G', needs, noSteps[0], []).findings
    .find(f => f.needKind === 'steps-with-rails').status, 'met');

  const noRails = build([{ id: 'x', type: '步行', from: 'A', to: 'B', slot: '13:00', text: '经三阶，无扶手。' }]);
  // “无扶手”不满足扶手需求：构造显式无扶手条件
  noRails[0].conditions = [{ kind: 'steps-rails', record: 'x', quote: '无扶手', range: [0, 3], attrs: { hasRails: false, noSteps: false } }];
  assert.equal(assessSegment('G', needs, noRails[0], []).status, 'blocked');
});

test('讲解场次超出要求时段判 blocked；在场内判 met', () => {
  const needs = lowerGradeNeeds();
  const tooLate = build([{ id: 's9', type: '讲解', from: 'X', to: 'X', slot: '15:30', text: '讲解。' }]);
  assert.equal(assessSegment('G', needs, tooLate[0], []).findings
    .find(f => f.needKind === 'session-window').status, 'blocked');
  const inside = build([{ id: 's2', type: '讲解', from: 'X', to: 'X', slot: '13:25', text: '讲解。' }]);
  assert.equal(assessSegment('G', needs, inside[0], []).findings
    .find(f => f.needKind === 'session-window').status, 'met');
});

test('返程描述不足以证明相同条件：去程与返程各自独立评估，不照搬结论', () => {
  const needs = lowerGradeNeeds();
  const segments = build([
    { id: 'out', type: '接驳', from: '学校', to: '场馆', slot: '09:00', text: '小巴可载轮椅，下午直达。' },
    { id: 'back', type: '接驳', from: '场馆', to: '学校', slot: '16:00', text: '乘原车返程，具体车辆待安排。' }
  ]);
  const replies = parseReplies([
    { id: 'v2', source: '去程接驳', received: '12:50', text: '去程小巴原说明仅指可折叠轮椅，无法载不能折叠的那部。' }
  ], new Map(segments.map(s => [s.id, s])));
  applyCorrections(segments, replies);
  assert.deepEqual(replies[0].targets.map(t => t.segmentId), ['out']); // 更正只针对去程

  const outbound = assessSegment('G', needs, segments.find(s => s.id === 'out'), replies);
  const returning = assessSegment('G', needs, segments.find(s => s.id === 'back'), replies);

  // 去程有明确（更正后的）限制 → blocked
  assert.equal(outbound.status, 'blocked');
  // 返程只有“原路返程”，不能据此照搬去程判断：轮椅如何载运没有原文依据 → uncertain
  assert.equal(returning.status, 'uncertain');
  assert.ok(returning.findings.some(f => f.status === 'unknown'));
});

test('确认回复可把场次接待条件标为已确认', () => {
  const segments = build([
    { id: 's4', type: '讲解', from: '大展厅', to: '大展厅', slot: '14:15', text: '可整团接待。展厅内无台阶。' }
  ]);
  const replies = parseReplies([
    { id: 'v1', source: '大展厅', received: '12:45', text: '十四点十五接待时段仍有席位，讲师等到十四点二十。' }
  ], new Map(segments.map(s => [s.id, s])));
  const result = assessSegment('G', lowerGradeNeeds(), segments[0], replies);
  assert.deepEqual(result.confirmedBy, ['v1']);
  assert.ok(result.findings.some(f => f.needKind === 'reception-confirmation'));
});
