import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSegments } from '../src/segments.js';
import { parseReplies, applyCorrections, replyTimeToMinutes } from '../src/replies.js';

const segments = () => parseSegments([
  { id: 's3', type: '接驳', from: '西门', to: '大展厅', slot: '13:35', text: '小巴可载轮椅，下午直达。' },
  { id: 's4', type: '讲解', from: '大展厅', to: '大展厅', slot: '14:15', text: '可整团接待。展厅内无台阶。' },
  { id: 's2', type: '讲解', from: '小展厅', to: '小展厅', slot: '13:25', text: '接受两部轮椅。全团同场时须提前安排。' }
]).segments;

test('中文时间“十四点二十”可转分钟，回复按时间与来源关联场次', () => {
  assert.equal(replyTimeToMinutes('十四点十五接待时段仍有席位，讲师等到十四点二十。'), 14 * 60 + 15);
  const replies = parseReplies([
    { id: 'v1', source: '大展厅', received: '12:45', text: '十四点十五接待时段仍有席位，讲师等到十四点二十。' },
    { id: 'v3', source: '小展厅', received: '12:55', text: '十三点二十五的场可两组同听，走廊开放时间已核实。' }
  ], new Map(segments().map(s => [s.id, s])));
  assert.deepEqual(replies[0].targets.map(t => t.segmentId), ['s4']);
  assert.deepEqual(replies[1].targets.map(t => t.segmentId), ['s2']);
  assert.equal(replies[0].kind, 'confirmation');
});

test('接驳方澄清只指可折叠型：宣传条件被更正取代，新条件挂回复编号', () => {
  const segs = segments();
  const replies = parseReplies([
    { id: 'v2', source: '接驳方', received: '12:50', text: '小巴原说明仅指可折叠轮椅，无法载不能折叠的那部。' }
  ], new Map(segs.map(s => [s.id, s])));
  assert.equal(replies[0].kind, 'correction');
  assert.deepEqual(replies[0].targets.map(t => t.segmentId), ['s3']);
  applyCorrections(segs, replies);
  const s3 = segs.find(s => s.id === 's3');
  const capacity = s3.conditions.find(c => c.kind === 'wheelchair-capacity');
  assert.equal(capacity.supersededBy, 'v2'); // 宣传文案不再可采信
  const foldOnly = s3.conditions.find(c => c.kind === 'foldable-only' && c.attrs.imposedBy === 'v2');
  assert.ok(foldOnly);
  assert.match(foldOnly.quote, /仅指可折叠轮椅/); // 更正原句保留
});
