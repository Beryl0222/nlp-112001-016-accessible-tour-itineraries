#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { readMaterials } from './materials.js';
import { analyzeMaterials } from './analysis.js';
import { planItineraries } from './planner.js';
import { BookingLedger } from './ledger.js';
import { buildGuideBrief, explainToParents, answerGuideQuestion } from './brief.js';

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const key = token.slice(2);
      if (key === 'json' || key === 'dry' || key === 'rain') args.flags[key] = true;
      else args.flags[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function planningOptions(flags) {
  const options = {};
  if (flags.weather) options.weather = flags.weather;
  if (flags.dry) options.weather = 'dry';
  if (flags.rain) options.weather = 'rain';
  return options;
}

function printPlanning(analysis, group, flags) {
  const result = planItineraries(analysis, { group, ...planningOptions(flags) });
  if (flags.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(`# ${result.group || group || '全部团组'}：行程承诺评估\n`);
  for (const plan of result.plans) {
    const label = { committable: '可承诺', needs_confirmation: '待确认', unavailable: '不可承诺' }[plan.status];
    console.log(`## ${plan.id} — ${label}`);
    console.log(`顺序：${plan.resourceIds.join(' → ')}`);
    for (const issue of plan.issues) console.log(`- [${issue.severity}] ${issue.message}`);
    for (const adj of plan.adjustments) console.log(`- 调整：${adj.message}`);
    for (const pref of plan.sacrificedPreferences) console.log(`- 舍弃偏好：${pref.message}`);
    if (!plan.issues.length) console.log('- 硬性需求、连接和接待确认均通过。');
    console.log('');
  }
  if (result.brokenConnections.length) {
    console.log('## 接不上的组合');
    for (const b of result.brokenConnections) console.log(`- ${b.resourceIds.join(' → ')}：${b.message}`);
  }
}

export async function runCli(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const command = args._[0] || 'report';
  const directoryOption = args.flags.directory || process.env.MATERIALS_DIR;
  const directory = directoryOption
    ? pathToFileURL(path.resolve(directoryOption) + path.sep)
    : undefined;
  const tables = await readMaterials(directory);
  const analysis = analyzeMaterials(tables);

  if (command === 'analyze' || command === 'parse') {
    if (args.flags.json) console.log(JSON.stringify(analysis, null, 2));
    else {
      for (const g of analysis.groups) {
        console.log(`${g.group}: wheelchairs=${JSON.stringify(g.wheelchairs)}, companions=${JSON.stringify(g.companionGroups)}`);
      }
    }
    return;
  }

  if (command === 'plan' || command === 'report') {
    if (args.flags.group) {
      printPlanning(analysis, args.flags.group, args.flags);
    } else if (args.flags.json) {
      const reports = Object.fromEntries(analysis.groups.map(g => [
        g.group,
        planItineraries(analysis, { group: g.group, ...planningOptions(args.flags) })
      ]));
      console.log(JSON.stringify({ groups: reports }, null, 2));
    } else {
      for (const g of analysis.groups) printPlanning(analysis, g.group, args.flags);
    }
    return;
  }

  if (command === 'brief') {
    const ledger = new BookingLedger(analysis);
    const brief = buildGuideBrief(analysis, ledger, args.flags.group || analysis.groups[0]?.group, planningOptions(args.flags));
    console.log(args.flags.json ? JSON.stringify(brief, null, 2) : brief.markdown);
    return;
  }

  if (command === 'ask') {
    const question = args.flags.question || args.flags.q || args._.slice(1).join(' ');
    const answer = answerGuideQuestion(analysis, args.flags.group || analysis.groups[0]?.group, question, planningOptions(args.flags));
    console.log(args.flags.json ? JSON.stringify(answer, null, 2) : answer.markdown);
    return;
  }

  if (command === 'parents' || command === 'parent') {
    const explanation = explainToParents(analysis, args.flags.group || analysis.groups[0]?.group, planningOptions(args.flags));
    console.log(args.flags.json ? JSON.stringify(explanation, null, 2) : explanation.markdown);
    return;
  }

  if (command === 'scenario') {
    // Reproducible end-to-end story from the supplied synthetic records.
    const before = analyzeMaterials({
      ...tables,
      '接待回复.json': tables['接待回复.json'].filter(r => r.id !== 'v2')
    });
    const ledger = new BookingLedger(before);
    ledger.createBooking({
      id: 'B-EXISTING',
      tourId: 'T-2026-EXAMPLE',
      group: '低年级同行组',
      segmentIds: ['s3', 's4'],
      sessionIds: ['s4'],
      status: 'confirmed'
    });
    ledger.confirmBooking('B-EXISTING', { sourceId: 's3', text: '小巴可载轮椅，下午直达。' });

    const correction = tables['接待回复.json'].find(r => r.id === 'v2');
    const impact = ledger.applyReply(correction);
    const after = analyzeMaterials(tables);
    const brief = buildGuideBrief(after, new BookingLedger(after), '低年级同行组');
    console.log(JSON.stringify({ impact, updatedBooking: ledger.get('B-EXISTING'), brief: brief.markdown }, null, 2));
    return;
  }

  if (args.flags.help || command === 'help') {
    console.log(`用法:
  node cli.js report [--group 名称] [--json] [--dry|--rain] [--directory 资料目录]
  node cli.js brief [--group 名称] [--json]
  node cli.js ask --group 名称 --question "s3 轮椅"
  node cli.js parents [--group 名称] [--json] [--dry|--rain]
  node cli.js analyze [--json]
  node cli.js scenario`);
    return;
  }

  throw new Error(`未知命令：${command}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch(err => {
    console.error(err.message);
    process.exitCode = 1;
  });
}
