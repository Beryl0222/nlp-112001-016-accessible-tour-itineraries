// 系统总入口：串起资料读取、解析、更正应用、逐组评估与路线判定。

import { readMaterials } from '../materials.js';
import { parseNeeds } from './needs.js';
import { parseSegments } from './segments.js';
import { parseReplies, applyCorrections } from './replies.js';
import { evaluateRoutesForGroup, validateGrouping } from './itinerary.js';
import { TourLedger } from './ledger.js';
import { explainForParent, briefingForGuide } from './explanations.js';

/**
 * 处理一批资料，返回可直接供接单人员使用的结构化结果。
 * @param {URL|string} [directory] 资料目录
 */
export async function analyze(directory) {
  const tables = await readMaterials(directory);
  const { groups: needsByGroup, all: allNeeds } = parseNeeds(tables['需求.json']);
  const { segments, byId: segmentById } = parseSegments(tables['资源.json']);
  const replies = parseReplies(tables['接待回复.json'], segmentById);

  // 先应用较晚录入的更正，再做任何承诺判断
  applyCorrections(segments, replies);

  const groupResults = {};
  for (const [group, needs] of needsByGroup) {
    groupResults[group] = {
      needs,
      routes: evaluateRoutesForGroup(group, needs, segments, replies)
    };
  }

  return {
    tables,
    needsByGroup,
    allNeeds,
    segments,
    segmentById,
    replies,
    groupResults,
    validateGrouping: chosen => validateGrouping(needsByGroup, chosen, segmentById),
    explainForParent: group => explainForParent(group, groupResults[group].routes)
  };
}

export {
  parseNeeds,
  parseSegments,
  parseReplies,
  applyCorrections,
  evaluateRoutesForGroup,
  validateGrouping,
  TourLedger,
  explainForParent,
  briefingForGuide
};
