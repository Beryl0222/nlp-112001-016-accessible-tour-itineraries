import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseSegments, toMinutes } from '../src/segments.js';

const seg = (id, type, text, extra = {}) => ({
  id, type, from: 'A', to: 'B', slot: '13:00', text, ...extra
});

test('“经三阶，都有扶手”解析出台阶数与扶手成立', () => {
  const { byId } = parseSegments([seg('s1', '步行', '经三阶，都有扶手。雨天停行。')]);
  const rails = byId.get('s1').conditions.find(c => c.kind === 'steps-rails');
  assert.equal(rails.attrs.stepCount, 3);
  assert.equal(rails.attrs.hasRails, true);
  assert.equal(rails.quote, '三阶，都有扶手'); // 原句保留
});

test('“雨天停行”“须提前安排”成为独立条件并保留粤语原句', () => {
  const { byId } = parseSegments([
    seg('s1', '步行', '经三阶，都有扶手。雨天停行。'),
    seg('s2', '讲解', '接受两部轮椅。全团同场时须提前安排。', { from: 'B', to: 'B' })
  ]);
  assert.equal(byId.get('s1').conditions.some(c => c.kind === 'weather-closure'), true);
  const advance = byId.get('s2').conditions.find(c => c.kind === 'advance-arrangement');
  assert.equal(advance.quote, '须提前安排');
});

test('“视轮椅宽度而定”与“可整团接待”可被识别', () => {
  const { byId } = parseSegments([
    seg('x', '接驳', '能否通过视轮椅宽度而定。'),
    seg('y', '讲解', '可整团接待。展厅内无台阶。', { from: 'B', to: 'B' })
  ]);
  assert.equal(byId.get('x').conditions.some(c => c.kind === 'width-dependent'), true);
  assert.equal(byId.get('y').conditions.some(c => c.kind === 'whole-group-reception'), true);
  assert.equal(byId.get('y').conditions.find(c => c.kind === 'steps-rails').attrs.noSteps, true);
});

test('步行用时解析为分钟数', () => {
  const { byId } = parseSegments([seg('s5', '步行', '可沿连廊步行，走到北门用时十分钟。')]);
  assert.equal(byId.get('s5').conditions.find(c => c.kind === 'walk-duration').attrs.minutes, 10);
  assert.equal(toMinutes('13:25'), 805);
  assert.equal(toMinutes('bad'), null);
});
