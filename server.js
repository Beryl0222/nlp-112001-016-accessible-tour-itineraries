import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readMaterials } from './materials.js';
import { createService } from './api.js';
import { createApp } from './app.js';

const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '0.0.0.0';
const directory = process.env.MATERIALS_DIR
  ? pathToFileURL(path.resolve(process.env.MATERIALS_DIR) + path.sep)
  : undefined;

const materials = await readMaterials(directory);
const service = createService(materials);
const server = createServer(createApp(service));

server.listen(port, host, () => {
  console.log(`Accessible tour service listening at http://${host}:${port}`);
});

export { server };
