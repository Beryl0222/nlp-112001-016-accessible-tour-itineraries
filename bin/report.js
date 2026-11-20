#!/usr/bin/env node
// 命令行报告：打印每组的候选路线判定、家长说明与确认台账演示。

import { analyze, TourLedger, briefingForGuide } from '../src/index.js';

const analysis = await analyze();
const ledger = new TourLedger();
const tourId = TourLedger.createTourId('研学团');

for (const [group, result] of Object.entries(analysis.groupResults)) {
  process.stdout.write(`\n========== ${group} ==========\n`);
  process.stdout.write(analysis.explainForParent(group) + '\n');

  for (const route of result.routes) {
    if (!route.connected) continue; // 不连通的路线不能承诺，也不进入确认台账
    for (const assessment of route.assessments) {
      ledger.recordConfirmation(tourId, group, assessment.segmentId, assessment);
    }
  }
}

// 演示 v2 更正传播：只影响含 s3 的路线与确认
const v2 = analysis.replies.find(reply => reply.id === 'v2');
if (v2) {
  const affected = ledger.applyExternalCorrection(tourId, v2, ['s3'], ['s1', 's2', 's4', 's5']);
  process.stdout.write('\n========== 接驳方澄清后的受影响确认 ==========\n');
  for (const entry of affected) {
    process.stdout.write(`${entry.group} / ${entry.segmentId} -> ${entry.state}\n  ${entry.note}\n`);
  }
}

process.stdout.write('\n========== 导游按团领取的当前说明 ==========\n');
process.stdout.write(briefingForGuide(ledger, tourId) + '\n');
