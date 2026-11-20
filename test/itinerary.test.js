import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readMaterials } from '../materials.js';
import { parseNeeds } from '../src/needs.js';
import { parseSegments } from '../src/segments.js';
import { parseReplies, applyCorrections } from '../src/replies.js';
import { enumerateRoutes, evaluateRoutesForGroup, validateGrouping } from '../src/itinerary.js';

const load = async () => {
  const tables = await readMaterials();
  const needs = parseNeeds(tables['需求.json']);
  const { segments, byId } = parseSegments(tables['资源.json']);
  const replies = parseReplies(tables['接待回复.json'], byId);
  applyCorrections(segments, replies);
  return { needs, segments, byId, replies };
};

test('枚举出门北门与西门两个入口的候选路线，并保留时间不连通的失败路线', async () => {
  const { segments } = await load();
  const routes = enumerateRoutes(segments).map(r => r.route.map(s => s.id));
  assert.deepEqual(routes, [
    ['s1', 's2'],
    ['s3', 's4'],
    ['s5', 's1', 's2']
  ]);
});

test('相邻路段必须地点相接且时间不倒退：s5(13:05)→s1(13:00) 判不连通', async () => {
  const { segments } = await load();
  const broken = enumerateRoutes(segments).find(r => r.route[0].id === 's5');
  assert.equal(broken.connectivity.every(step => step.ok), false);
  assert.match(broken.connectivity.find(step => !step.ok).reason, /时间倒退/);
});

test('低年级同行组：s3 因非折叠轮椅 blocked；s1/s2 因缺确认 uncertain；没有可承诺路线', async () => {
  const { needs, segments, replies } = await load();
  const groupNeeds = needs.groups.get('低年级同行组');
  const evaluations = evaluateRoutesForGroup('低年级同行组', groupNeeds, segments, replies);

  const viaWest = evaluations.find(e => e.segmentIds.join() === 's3,s4');
  assert.deepEqual(viaWest.blockedSegments, ['s3']);
  assert.equal(viaWest.committable, false);

  const viaNorth = evaluations.find(e => e.segmentIds.join() === 's1,s2');
  assert.deepEqual(viaNorth.uncertainSegments.sort(), ['s1', 's2']);
  assert.equal(viaNorth.committable, false);

  assert.ok(evaluations.every(e => e.committable === false));
});

test('家长观察组：西门路线各硬性需求有据且已确认，可承诺；电梯偏好被舍弃并说明', async () => {
  const { needs, segments, replies } = await load();
  const groupNeeds = needs.groups.get('家长观察组');
  const evaluations = evaluateRoutesForGroup('家长观察组', groupNeeds, segments, replies);
  const viaWest = evaluations.find(e => e.segmentIds.join() === 's3,s4');
  assert.equal(viaWest.committable, true);
  assert.equal(viaWest.blockedSegments.length, 0);
  assert.equal(viaWest.uncertainSegments.length, 0);
  assert.ok(viaWest.lostPreferences.some(p => /lift would be preferable/.test(p.basis[0].quote)));
});

test('同行约束：约定同行的组不得拆到不同交通段/场次；两组可错场或同场', async () => {
  const { needs, byId } = await load();
  // 两组错开：低年级走北门 s1/s2，家长走西门 s3/s4
  const staggered = validateGrouping(needs.groups, {
    '低年级同行组': ['s1', 's2'],
    '家长观察组': ['s3', 's4']
  }, byId);
  assert.equal(staggered.violations.length, 0);
  assert.equal(staggered.sessionPairs[0].sharedSession, false);
  assert.match(staggered.sessionPairs[0].note, /错开/);

  // 同场：两组共用 s2
  const together = validateGrouping(needs.groups, {
    '低年级同行组': ['s1', 's2'],
    '家长观察组': ['s1', 's2']
  }, byId);
  assert.equal(together.sessionPairs[0].sharedSession, true);

  // 未给某组安排路线 -> 违规
  const missing = validateGrouping(needs.groups, { '家长观察组': ['s3', 's4'] }, byId);
  assert.equal(missing.violations.some(v => v.group === '低年级同行组'), true);
});
