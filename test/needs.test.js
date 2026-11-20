import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseNeeds } from '../src/needs.js';

const row = (id, locale, text, group = 'G') => ({ id, group, locale, text });

test('粤语“两部轮椅只有一部摺得埋”解析为两部、一折叠一非折叠', () => {
  const { all } = parseNeeds([row('r1', 'zh-HK', '两部轮椅只有一部摺得埋。')]);
  const fleet = all.find(need => need.kind === 'wheelchair-fleet');
  assert.deepEqual(fleet.attrs, { count: 2, foldableCount: 1, nonFoldableCount: 1 });
  assert.equal(fleet.strength, 'hard');
  assert.equal(fleet.quote, '两部轮椅'); // 原句片段原样保留
});

test('英文近义表达与粤语同行约束映射到同一硬性需求', () => {
  const { all } = parseNeeds([
    row('r1', 'zh-HK', '小朋友一定要同带队老师一齐去。'),
    row('r2', 'en', 'The child must stay with the teacher; the child cannot be separated from the group.')
  ]);
  const kinds = all.filter(need => need.kind === 'accompany-teacher');
  // 英文句中两个近义短语都指向同一条同行需求
  assert.equal(kinds.length, 3);
  assert.ok(kinds.every(need => need.strength === 'hard'));
  assert.equal(kinds[0].quote, '一定要同带队老师一齐去');
  assert.match(kinds[1].quote, /must stay with/);
  assert.match(kinds[2].quote, /cannot be separated from/);
});

test('讲解时段窗口支持“下午一点到三点”与英文 from-to', () => {
  const zh = parseNeeds([row('r2', 'zh', '讲解想在下午一点到三点开始。')]).all
    .find(need => need.kind === 'session-window');
  assert.deepEqual([zh.attrs.startHour, zh.attrs.endHour], [13, 15]);

  const en = parseNeeds([row('r3', 'en', 'We need a session from 2 to 3 pm.')]).all
    .find(need => need.kind === 'session-window');
  assert.deepEqual([en.attrs.startHour, en.attrs.endHour], [2, 3]);
});

test('电梯是可舍弃的偏好，台阶扶手是硬性需求', () => {
  const { all } = parseNeeds([
    row('r3', 'en', 'A lift would be preferable, but we can take steps with rails.')
  ]);
  assert.equal(all.find(need => need.kind === 'lift-preference').strength, 'soft');
  assert.equal(all.find(need => need.kind === 'steps-with-rails').strength, 'hard');
});

test('需求按同行组聚合', () => {
  const { groups } = parseNeeds([
    row('r1', 'zh-HK', '能短距离步行。', '甲组'),
    row('r2', 'en', 'A short walk is fine.', '乙组')
  ]);
  assert.deepEqual([...groups.keys()].sort(), ['乙组', '甲组']);
});
