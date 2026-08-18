// AI Company HQ — proxy: org chart stays visible, chat with each role.
// Connects to an OpenClaw Gateway over WebSocket RPC (protocol v4).
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const GATEWAY_WS = process.env.GATEWAY_WS || 'ws://127.0.0.1:18789';
const PORT = parseInt(process.env.PORT || '8813', 10);
const PUB = path.join(__dirname, 'public');
// roles.json is the generic public template. If a roles.local.json exists
// (gitignored — your own private departments/personas/business names), it
// takes priority. This keeps real business/personal data out of version
// control while the shipped template stays a clean, reusable framework.
const ROLES_FILE = fs.existsSync(path.join(__dirname, 'roles.local.json'))
  ? path.join(__dirname, 'roles.local.json')
  : path.join(__dirname, 'roles.json');
const ROLES = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8'));
// Label used for the human principal in seeded first-turn prompts. Override
// with OWNER_LABEL if you want your own name/title instead of the generic default.
const OWNER_LABEL = process.env.OWNER_LABEL || 'Founder';
const COO_LABEL = process.env.COO_LABEL || 'COO Agent';

// Token resolution: GATEWAY_TOKEN env wins; else GATEWAY_TOKEN_FILE; else machine default path.
function resolveToken() {
  if (process.env.GATEWAY_TOKEN) return process.env.GATEWAY_TOKEN.trim();
  const file = process.env.GATEWAY_TOKEN_FILE || path.join(os.homedir(), '.openclaw/secrets/gateway-token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  return null;
}
const token = resolveToken();
if (!token) {
  console.error('[hq] No gateway token. Set GATEWAY_TOKEN or GATEWAY_TOKEN_FILE (or create the default path).');
  process.exit(1);
}

const rpcId = () => crypto.randomUUID();
let ws = null;
let pending = new Map();

function connect() {
  ws = new WebSocket(GATEWAY_WS);
  ws.onopen = () => {
    send('connect', {
      minProtocol: 4, maxProtocol: 4,
      client: { id: 'gateway-client', version: '1.0.0', platform: 'linux', mode: 'backend' },
      role: 'operator', scopes: ['operator.read', 'operator.write'],
      caps: [], commands: [], permissions: {},
      auth: { token }, locale: 'en-US', userAgent: 'ai-company-hq/1.0.0'
    }).then(() => console.log('[hq] gateway connected'));
  };
  ws.onmessage = (ev) => {
    let frame; try { frame = JSON.parse(ev.data); } catch { return; }
    if (frame.type === 'res') {
      const p = pending.get(frame.id);
      if (p) { pending.delete(frame.id); frame.ok ? p.resolve(frame.payload) : p.reject(new Error((frame.error && frame.error.message) || 'rpc error')); }
    }
  };
  ws.onclose = () => { console.log('[hq] ws closed, reconnect in 3s'); setTimeout(connect, 3000); };
  ws.onerror = () => console.log('[hq] ws error');
}

function send(method, params) {
  return new Promise((resolve, reject) => {
    const id = rpcId();
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ type: 'req', id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout: ' + method)); } }, 60000);
  });
}

async function ensureSession(role) {
  const key = 'agent:main:hq-' + role.id;
  try {
    const r = await send('sessions.describe', { sessionKey: key });
    if (r && r.key) return key;
  } catch (e) { /* not found -> create */ }
  await send('sessions.create', { key, agentId: 'main', label: 'HQ · ' + role.name });
  try { await send('sessions.patch', { key, model: process.env.ROLE_MODEL || 'deepseek/deepseek-v4-flash' }); } catch (e) { /* model pin optional */ }
  return key;
}

function msgText(m) {
  if (!m) return '';
  const c = m.content;
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map(b => (b && b.type === 'text' ? b.text : '')).join('');
  return m.text || '';
}

async function getHistory(role, limit = 40) {
  const key = await ensureSession(role);
  try {
    const r = await send('chat.history', { sessionKey: key, limit });
    const msgs = (r && r.messages) || [];
    return msgs.filter(m => m && m.role !== 'system').map(m => ({ role: m.role, text: msgText(m), seq: (m.__openclaw && m.__openclaw.seq) || 0 }));
  } catch (e) { return []; }
}

async function chat(role, text) {
  const key = await ensureSession(role);
  const before = await getHistory(role, 10);
  const beforeMaxSeq = Math.max(0, ...before.map(m => m.seq));
  const first = before.length === 0;
  const payload = first
    ? `${role.persona}\n\n${OWNER_LABEL} (CEO) says: ${text}`
    : text;
  await send('chat.send', { sessionKey: key, message: payload, fastMode: 'auto', idempotencyKey: rpcId() });
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const h = await send('chat.history', { sessionKey: key, limit: 10 });
      const msgs = (h && h.messages) || [];
      const fresh = msgs.filter(m => m && m.role === 'assistant' && ((m.__openclaw && m.__openclaw.seq) || 0) > beforeMaxSeq);
      if (fresh.length > 0) {
        const txt = msgText(fresh[fresh.length - 1]).trim();
        if (txt && txt !== 'NO_REPLY') return txt;
      }
    } catch (e) { /* keep polling */ }
  }
  return '⚠️ No reply within 240s. Check the gateway.';
}

// ---- HTTP ----
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const route = u.pathname;
  const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
  const body = (cb) => { let d = ''; req.on('data', c => d += c); req.on('end', () => { try { cb(JSON.parse(d || '{}')); } catch { cb({}); } }); };

  if (route === '/api/health') return json(200, { ok: true, ws: ws && ws.readyState === 1, roles: ROLES.length });
  if (route === '/api/config') return json(200, { ownerLabel: OWNER_LABEL, cooLabel: COO_LABEL });
  if (route === '/api/roles') return json(200, { roles: ROLES.map(r => ({ id: r.id, name: r.name, dept: r.dept, level: r.level, icon: r.icon, scope: r.scope })) });
  if (route === '/api/history') {
    const role = ROLES.find(r => r.id === u.searchParams.get('role'));
    if (!role) return json(404, { error: 'no role' });
    return getHistory(role).then(h => json(200, { messages: h })).catch(e => json(500, { error: String(e) }));
  }
  if (route === '/api/chat' && req.method === 'POST') {
    return body(async (b) => {
      const role = ROLES.find(r => r.id === b.role);
      if (!role) return json(404, { error: 'no role' });
      if (!b.text || !b.text.trim()) return json(400, { error: 'empty' });
      try {
        const reply = await chat(role, b.text.trim());
        json(200, { reply });
      } catch (e) { json(500, { error: String(e) }); }
    });
  }
  // static
  let file = route === '/' ? 'index.html' : route.slice(1);
  const fp = path.join(PUB, file);
  if (!fp.startsWith(PUB)) return json(403, {});
  fs.readFile(fp, (err, data) => {
    if (err) return json(404, { error: 'not found' });
    const ext = path.extname(fp);
    const ct = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
});

connect();
server.listen(PORT, '127.0.0.1', () => console.log('[hq] http://127.0.0.1:' + PORT));
