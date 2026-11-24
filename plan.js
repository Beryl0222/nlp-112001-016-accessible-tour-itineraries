export * from './planner.js';
export * from './api.js';

import { pathToFileURL } from 'node:url';
import { runCli } from './cli.js';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(['report', ...process.argv.slice(2)]).catch(error => {
    console.error(error.stack || error.message);
    process.exitCode = 1;
  });
}
