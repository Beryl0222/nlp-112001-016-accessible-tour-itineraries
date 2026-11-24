import { createServer } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createService } from './api.js';
import { readMaterials } from './materials.js';

const PAGE = `<!doctype html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>研学团可达性行程解释</title>
<style>
:root { color-scheme: light; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans TC", "Microsoft JhengHei", sans-serif; }
body { margin: 0; background: #f6f7f9; color: #17202a; }
header { background: #12355b; color: white; padding: 20px 28px; }
main { max-width: 1180px; margin: 24px auto; padding: 0 20px; display: grid; gap: 18px; }
.card { background: white; border: 1px solid #dce1e8; border-radius: 12px; padding: 18px; box-shadow: 0 1px 2px rgba(0,0,0,.04); }
.row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
button, select { border: 1px solid #12355b; border-radius: 8px; padding: 8px 12px; font-size: 15px; background: white; color: #12355b; cursor: pointer; }
button.primary { background: #12355b; color: white; }
.badge { display: inline-block; border-radius: 999px; padding: 3px 10px; font-size: 13px; font-weight: 700; }
.committable { background: #e6f6ec; color: #146c43; }
.needs_confirmation { background: #fff4ce; color: #8a6100; }
.unavailable { background: #fde8e8; color: #9b1c1c; }
.issue { border-left: 4px solid #d33; padding: 8px 10px; margin: 8px 0; background: #fff7f7; }
.issue.uncertain, .issue.condition { border-color: #c47f00; background: #fffbef; }
.quote { color: #445; font-size: 13px; }
code { background: #eef1f5; padding: 1px 5px; border-radius: 4px; }
pre { white-space: pre-wrap; word-break: break-word; background: #101820; color: #e8eef7; padding: 16px; border-radius: 10px; overflow:auto; }
.grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(320px,1fr)); gap:14px; }
</style>
</head>
<body>
<header><h1>研学团可达性：承诺前先指出不确定路段</h1><p>同行分组 · 时段连接 · 多语原文证据 · 更正传播 · 导游说明</p></header>
<main>
  <section class="card row">
    <label for="group"><strong>按团领取说明</strong></label>
    <select id="group"></select>
    <button class="primary" id="refresh">重新评估</button>
    <button id="brief">导游说明 JSON</button>
    <button id="parents">家长解释</button>
  </section>
  <section id="summary" class="grid"></section>
  <section class="card"><h2>家长解释</h2><div id="parentText">选择团组后可查看。</div></section>
  <section class="card"><h2>导游当前说明 / 证据复现</h2><pre id="output">正在读取资料…</pre></section>
</main>
<script>
let state;
const $ = id => document.getElementById(id);
async function load() {
  state = await fetch('/api/state').then(r => r.json());
  const groups = state.analysis.groups.map(g => g.group);
  $('group').innerHTML = groups.map(g => '<option>' + g + '</option>').join('');
  render();
}
function badge(status) { return '<span class="badge ' + status + '">' + ({committable:'可承诺',needs_confirmation:'待确认',unavailable:'不可承诺'})[status] + '</span>'; }
function render() {
  const group = $('group').value;
  const plan = state.plans[group];
  $('summary').innerHTML = plan.plans.map(p => '<article class="card"><h3>' + p.id + ' ' + badge(p.status) + '</h3><p>' + p.resourceIds.join(' → ') + '</p>' + p.issues.map(i => '<div class="issue ' + i.severity + '"><strong>[' + i.code + ']</strong> ' + i.message + '</div>').join('') + p.adjustments.map(a => '<p>🛠 ' + a.message + '</p>').join('') + '</article>').join('');
  fetch('/api/parents?group=' + encodeURIComponent(group)).then(r=>r.json()).then(x => $('parentText').innerText = x.markdown);
  $('output').textContent = '点击“导游说明 JSON”查看可复现证据。';
}
$('refresh').onclick = load;
$('group').onchange = render;
$('brief').onclick = async () => { const g=$('group').value; const x=await fetch('/api/brief?group='+encodeURIComponent(g)).then(r=>r.json()); $('output').textContent=x.markdown + '\\n\\n' + JSON.stringify({locators:x.locators},null,2); };
$('parents').onclick = async () => { const g=$('group').value; const x=await fetch('/api/parents?group='+encodeURIComponent(g)).then(r=>r.json()); $('output').textContent=x.markdown; };
load().catch(e => $('output').textContent = String(e));
</script>
</body>
</html>`;

export function createApp(service) {
  return async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const send = (status, body, type = 'application/json; charset=utf-8') => {
      res.writeHead(status, { 'content-type': type });
      res.end(type.includes('json') ? JSON.stringify(body, null, 2) : body);
    };

    if (req.method === 'GET' && url.pathname === '/') return send(200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/health') return send(200, { ok: true });

    if (req.method === 'GET' && url.pathname === '/api/state') {
      const groups = Object.fromEntries(service.analysis.groups.map(g => [g.group, service.plan({ group: g.group })]));
      return send(200, { analysis: service.analysis, plans: groups });
    }
    if (req.method === 'GET' && url.pathname === '/api/plan') {
      return send(200, service.plan({ group: url.searchParams.get('group') || undefined }));
    }
    if (req.method === 'GET' && url.pathname === '/api/brief') {
      return send(200, service.brief(url.searchParams.get('group') || undefined));
    }
    if (req.method === 'GET' && url.pathname === '/api/ask') {
      const { answerGuideQuestion } = await import('./brief.js');
      return send(200, answerGuideQuestion(service.analysis, url.searchParams.get('group') || undefined, url.searchParams.get('q') || ''));
    }
    if (req.method === 'GET' && url.pathname === '/api/parents') {
      const { explainToParents } = await import('./brief.js');
      return send(200, explainToParents(service.analysis, url.searchParams.get('group') || undefined));
    }
    if (req.method === 'GET' && url.pathname === '/api/bookings') {
      return send(200, [...service.ledger.bookings.values()]);
    }
    if (req.method === 'POST' && url.pathname === '/api/bookings') {
      return readJson(req, send, body => send(201, service.book(body)));
    }
    if (req.method === 'POST' && url.pathname === '/api/companion-change') {
      return readJson(req, send, body => send(200, service.changeCompanions(body.bookingId, body.change || body)));
    }
    if (req.method === 'POST' && url.pathname === '/api/replies') {
      return readJson(req, send, reply => send(200, service.applyCorrection(reply)));
    }
    send(404, { error: 'not found' });
  };
}

function readJson(req, send, onValue) {
  let raw = '';
  req.on('data', chunk => { raw += chunk; });
  req.on('end', () => {
    try {
      onValue(JSON.parse(raw || '{}'));
    } catch (error) {
      send(400, { error: error.message });
    }
  });
}

export function createRequestListener(materials) {
  const service = createService(materials);
  return createApp(service);
}

export async function startServer(options = {}) {
  const port = Number(options.port || process.env.PORT || 3000);
  const host = options.host || process.env.HOST || '0.0.0.0';
  const materials = options.materials || await readMaterials();
  const server = createServer(createApp(options.service || createService(materials)));
  await new Promise(resolve => server.listen(port, host, resolve));
  return server;
}

export default createApp;

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '0.0.0.0';
  const directory = process.env.MATERIALS_DIR
    ? pathToFileURL(path.resolve(process.env.MATERIALS_DIR) + path.sep)
    : undefined;
  const materials = await readMaterials(directory);
  const server = createServer(createApp(createService(materials)));
  server.listen(port, host, () => console.log(`Accessible tour service listening at http://${host}:${port}`));
}
