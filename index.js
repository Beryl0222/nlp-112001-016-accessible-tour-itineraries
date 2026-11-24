export * from './materials.js';
export * from './text-utils.js';
export * from './interpret.js';
export * from './analysis.js';
export * from './planner.js';
export * from './ledger.js';
export * from './brief.js';
export * from './scheduler.js';
export * from './api.js';

export { analyzeMaterials } from './analysis.js';
export { planItineraries, findRoutes, evaluateRoute, evaluateSegment } from './planner.js';
export { BookingLedger, createTourSystem, companionChangeImpact, correctionImpact, validateAssignment, assessReturnTrip } from './ledger.js';
export { buildGuideBrief, renderBriefMarkdown } from './brief.js';

import { pathToFileURL } from 'node:url';
import { runCli } from './cli.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
