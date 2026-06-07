'use strict';
const http = require('http');
const https = require('https');
const { exec } = require('child_process');
const fs = require('fs');
const url = require('url');

const PORT = process.env.PORT || 8080;
const RELAY_SECRET = process.env.RELAY_SECRET || '';
const OPENROUTER_KEY = process.env.OPENROUTER_KEY || '';

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
let registry = {
  banner: 'AI-Meeting Server — ready',
  mode: 'single',
  active_model: 'qwen',
  supervisor_id: null,
  debate: { rounds: 3, model_a: null, model_b: null },
  autonomous: {
    max_iter: 20,
    tools: { run_shell: false, read_file: false, write_file: false, http_fetch: false }
  },
  models: [
    {
      id: 'qwen',
      backend: 'ollama',
      target: 'huihui_ai/qwen2.5-abliterate:latest',
      name: 'Qwen 2.5 Abliterated',
      role: 'developer',
      enabled: true
    },
    {
      id: 'llama-small',
      backend: 'ollama',
      target: 'huihui_ai/llama3.2-abliterate:1b',
      name: 'Llama 3.2 1B Abliterated',
      role: 'researcher',
      enabled: true
    },
    {
      id: 'or-llama70b',
      backend: 'openrouter',
      target: 'meta-llama/llama-3.3-70b-instruct',
      name: 'Llama 3.3 70B Instruct',
      role: 'supervisor',
      enabled: false
    }
  ]
};

// ---------------------------------------------------------------------------
// Autonomous session state
// ---------------------------------------------------------------------------
let session = {
  running: false,
  paused: false,
  kill: false,
  iter: 0,
  log: [],
  _pauseResolve: null
};

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------
function getModel(id) { return registry.models.find(m => m.id === id) || null; }
function enabledModels() { return registry.models.filter(m => m.enabled); }
function getSupervisor() {
  if (registry.supervisor_id) return getModel(registry.supervisor_id);
  return registry.models.find(m => m.role === 'supervisor' && m.enabled) || null;
}

// ---------------------------------------------------------------------------
// Ollama chat (plain, no tools)
// ---------------------------------------------------------------------------
function ollamaChat(model, messages) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: model.target, messages, stream: false });
    const req = http.request({
      hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw).message.content); }
        catch (e) { reject(new Error('Ollama parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Ollama chat with tools (autonomous mode)
// ---------------------------------------------------------------------------
function ollamaChatTools(model, messages, tools) {
  return new Promise((resolve, reject) => {
    const payload = { model: model.target, messages, stream: false };
    if (tools.length) payload.tools = tools;
    const body = JSON.stringify(payload);
    const req = http.request({
      hostname: 'localhost', port: 11434, path: '/api/chat', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw).message); }
        catch (e) { reject(new Error('Ollama parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// OpenRouter chat (plain)
// ---------------------------------------------------------------------------
function openrouterChat(model, messages) {
  if (!OPENROUTER_KEY) return Promise.reject(new Error('OPENROUTER_KEY not set'));
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({ model: model.target, messages });
    const req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw).choices[0].message.content); }
        catch (e) { reject(new Error('OpenRouter parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// OpenRouter chat with tools (autonomous mode)
// ---------------------------------------------------------------------------
function openrouterChatTools(model, messages, tools) {
  if (!OPENROUTER_KEY) return Promise.reject(new Error('OPENROUTER_KEY not set'));
  return new Promise((resolve, reject) => {
    const payload = { model: model.target, messages };
    if (tools.length) payload.tools = tools;
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'openrouter.ai', path: '/api/v1/chat/completions', method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, res => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw).choices[0].message); }
        catch (e) { reject(new Error('OpenRouter parse error: ' + raw.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function modelChat(model, messages) {
  if (model.backend === 'ollama') return ollamaChat(model, messages);
  if (model.backend === 'openrouter') return openrouterChat(model, messages);
  return Promise.reject(new Error('Unknown backend: ' + model.backend));
}

function modelChatTools(model, messages, tools) {
  if (model.backend === 'ollama') return ollamaChatTools(model, messages, tools);
  if (model.backend === 'openrouter') return openrouterChatTools(model, messages, tools);
  return Promise.reject(new Error('Unknown backend: ' + model.backend));
}

// ---------------------------------------------------------------------------
// Tool execution
// ---------------------------------------------------------------------------
function runTool(name, args) {
  switch (name) {
    case 'run_shell':
      return new Promise(resolve => {
        exec(args.command, { timeout: 30000 }, (err, stdout, stderr) =>
          resolve(stdout || stderr || (err ? err.message : '(no output)')));
      });
    case 'read_file':
      try { return Promise.resolve(fs.readFileSync(args.path, 'utf8')); }
      catch (e) { return Promise.resolve('Error: ' + e.message); }
    case 'write_file':
      try { fs.writeFileSync(args.path, args.content || '', 'utf8'); return Promise.resolve('OK'); }
      catch (e) { return Promise.resolve('Error: ' + e.message); }
    case 'http_fetch':
      return new Promise(resolve => {
        try {
          const u = new URL(args.url);
          const mod = u.protocol === 'https:' ? https : http;
          const req = mod.request(u, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => resolve(data.slice(0, 4000)));
          });
          req.on('error', e => resolve('Error: ' + e.message));
          req.end();
        } catch (e) { resolve('Error: ' + e.message); }
      });
    default:
      return Promise.resolve('Unknown tool: ' + name);
  }
}

// ---------------------------------------------------------------------------
// Mode: single
// ---------------------------------------------------------------------------
async function modeSingle(messages, modelId) {
  const model = getModel(modelId || registry.active_model) || enabledModels()[0];
  if (!model) throw new Error('No active model available');
  const reply = await modelChat(model, messages);
  return { reply, model_used: model.id, mode: 'single' };
}

// ---------------------------------------------------------------------------
// Mode: multi
// ---------------------------------------------------------------------------
async function modeMulti(messages) {
  const models = enabledModels();
  if (!models.length) throw new Error('No enabled models');
  const results = await Promise.allSettled(models.map(m => modelChat(m, messages)));
  const replies = results.map((r, i) => ({
    id: models[i].id,
    name: models[i].name || models[i].id,
    reply: r.status === 'fulfilled' ? r.value : 'Error: ' + r.reason?.message
  }));
  return { replies, mode: 'multi' };
}

// ---------------------------------------------------------------------------
// Mode: supervisor
// ---------------------------------------------------------------------------
async function modeSupervisor(messages) {
  const supervisor = getSupervisor();
  const workers = enabledModels().filter(m => m.id !== supervisor?.id);
  if (!workers.length) throw new Error('No worker models enabled');

  const draftResults = await Promise.allSettled(workers.map(m => modelChat(m, messages)));
  const drafts = draftResults.map((r, i) => ({
    id: workers[i].id,
    name: workers[i].name || workers[i].id,
    draft: r.status === 'fulfilled' ? r.value : 'Error: ' + r.reason?.message
  }));

  if (!supervisor) {
    return { drafts, reply: drafts[0]?.draft || '', mode: 'supervisor', supervisor_used: null };
  }

  const combined = drafts.map(d => `[${d.name}]:\n${d.draft}`).join('\n\n---\n\n');
  const arbMessages = [
    ...messages,
    { role: 'assistant', content: combined },
    { role: 'user', content: 'Based on the drafts above, provide the single best final answer.' }
  ];
  const final = await modelChat(supervisor, arbMessages);
  return { drafts, reply: final, model_used: supervisor.id, mode: 'supervisor' };
}

// ---------------------------------------------------------------------------
// Mode: debate
// ---------------------------------------------------------------------------
async function modeDebate(messages) {
  const supervisor = getSupervisor();
  const eligible = enabledModels().filter(m => m.id !== supervisor?.id);
  if (eligible.length < 2) throw new Error('Need at least 2 non-supervisor models for debate');

  const modelA = registry.debate.model_a ? getModel(registry.debate.model_a) : eligible[0];
  const modelB = registry.debate.model_b ? getModel(registry.debate.model_b) : eligible[1];
  const rounds = Math.max(1, registry.debate.rounds || 3);

  const log = [];
  let msgsA = [...messages];
  let msgsB = [...messages];

  for (let i = 0; i < rounds; i++) {
    const aReply = await modelChat(modelA, msgsA);
    log.push({ model: modelA.id, round: i + 1, content: aReply });
    msgsA.push({ role: 'assistant', content: aReply });
    msgsB.push({ role: 'user', content: aReply });

    const bReply = await modelChat(modelB, msgsB);
    log.push({ model: modelB.id, round: i + 1, content: bReply });
    msgsB.push({ role: 'assistant', content: bReply });
    msgsA.push({ role: 'user', content: bReply });
  }

  if (!supervisor) {
    return { log, verdict: log[log.length - 1]?.content || '', mode: 'debate', supervisor_used: null };
  }

  const debateText = log.map(l => `[${l.model} — round ${l.round}]:\n${l.content}`).join('\n\n---\n\n');
  const verdictMessages = [
    ...messages,
    { role: 'user', content: `Here is a debate:\n\n${debateText}\n\nProvide your verdict on which position is stronger and why.` }
  ];
  const verdict = await modelChat(supervisor, verdictMessages);
  return { log, verdict, supervisor_used: supervisor.id, mode: 'debate' };
}

// ---------------------------------------------------------------------------
// Mode: autonomous agent loop
// ---------------------------------------------------------------------------
const TOOL_DEFS = [
  { type: 'function', function: { name: 'run_shell',  description: 'Execute a bash command on the server', parameters: { type: 'object', properties: { command: { type: 'string', description: 'Shell command to run' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'read_file',  description: 'Read a file from disk',                parameters: { type: 'object', properties: { path:    { type: 'string', description: 'Absolute or relative file path' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Write content to a file on disk',      parameters: { type: 'object', properties: { path:    { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'http_fetch', description: 'Make an outbound HTTP GET request',    parameters: { type: 'object', properties: { url:     { type: 'string', description: 'Full URL to fetch' } }, required: ['url'] } } },
];

async function modeAutonomous(systemPrompt, userMessage) {
  const model = getModel(registry.active_model) || enabledModels()[0];
  if (!model) throw new Error('No active model available');

  const enabledTools = TOOL_DEFS.filter(t => registry.autonomous.tools[t.function.name]);
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userMessage });

  session.log.push({ role: 'user', content: userMessage });
  session.iter = 0;
  session.kill = false;

  while (session.iter < registry.autonomous.max_iter && !session.kill) {
    session.iter++;

    let response;
    try {
      response = await modelChatTools(model, messages, enabledTools);
    } catch (e) {
      session.log.push({ role: 'system', content: 'Model error: ' + e.message });
      break;
    }

    // No tool calls — we're done
    if (!response.tool_calls || response.tool_calls.length === 0) {
      session.log.push({ role: 'assistant', content: response.content || '' });
      messages.push({ role: 'assistant', content: response.content || '' });
      break;
    }

    session.log.push({ role: 'assistant', content: response.content || '', tool_calls: response.tool_calls });
    messages.push({ role: 'assistant', content: response.content || '', tool_calls: response.tool_calls });

    for (const tc of response.tool_calls) {
      const toolName = tc.function.name;
      let toolArgs = {};
      try { toolArgs = JSON.parse(tc.function.arguments || '{}'); } catch (_) {}

      // If tool is disabled, pause and wait for dashboard approval
      if (!registry.autonomous.tools[toolName]) {
        session.paused = true;
        session.log.push({
          role: 'system',
          content: `PAUSED: tool "${toolName}" is disabled. Approve or Deny in dashboard.`,
          tool_call: { name: toolName, args: toolArgs, id: tc.id }
        });

        const approved = await new Promise(resolve => { session._pauseResolve = resolve; });
        session.paused = false;

        if (!approved) {
          const denyMsg = { role: 'tool', tool_call_id: tc.id, content: 'Tool use denied by user.' };
          session.log.push(denyMsg);
          messages.push(denyMsg);
          continue;
        }
      }

      const result = await runTool(toolName, toolArgs);
      const toolMsg = { role: 'tool', tool_call_id: tc.id, content: String(result) };
      session.log.push(toolMsg);
      messages.push(toolMsg);
    }
  }

  if (session.kill) {
    session.log.push({ role: 'system', content: 'Session killed by user.' });
  } else if (session.iter >= registry.autonomous.max_iter) {
    session.log.push({ role: 'system', content: `Max iterations (${registry.autonomous.max_iter}) reached.` });
  }

  session.running = false;
  session.kill = false;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => data += c);
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}); }
      catch (e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJSON(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function checkAuth(req) {
  if (!RELAY_SECRET) return true;
  return req.headers['x-relay-key'] === RELAY_SECRET;
}

function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ---------------------------------------------------------------------------
// Dashboard HTML
// ---------------------------------------------------------------------------
function dashboardHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI-Meeting</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',system-ui,sans-serif;background:#0d1117;color:#c9d1d9;min-height:100vh}
.topbar{background:#161b22;border-bottom:1px solid #30363d;padding:12px 20px;display:flex;align-items:center;gap:10px}
.topbar h1{font-size:1.1rem;color:#58a6ff;flex:1}
#dot{width:9px;height:9px;border-radius:50%;background:#444;flex-shrink:0}
#dot.on{background:#3fb950;animation:blink 1s infinite}
@keyframes blink{0%,100%{opacity:1}50%{opacity:.3}}
#statusTxt{font-size:.8rem;color:#8b949e}
.banner{background:#161b22;border:1px solid #30363d;border-left:4px solid #58a6ff;padding:8px 16px;margin:12px 20px;border-radius:4px;font-size:.85rem;color:#8b949e}
.layout{display:grid;grid-template-columns:300px 1fr;gap:12px;padding:0 20px 20px}
.col{display:flex;flex-direction:column;gap:12px}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:14px}
.card h2{font-size:.9rem;color:#58a6ff;border-bottom:1px solid #30363d;padding-bottom:8px;margin-bottom:10px}
.mcard{background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:9px 11px;margin-bottom:7px}
.mcard.off{opacity:.5}
.mname{font-weight:600;font-size:.85rem}
.mmeta{font-size:.72rem;color:#8b949e;margin-top:2px}
.mactions{display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;align-items:center}
.tag{display:inline-block;padding:1px 6px;border-radius:10px;font-size:.68rem;margin-left:6px}
.tag.developer{background:#1f6feb33;color:#58a6ff}
.tag.researcher{background:#3fb95033;color:#3fb950}
.tag.supervisor{background:#d2992233;color:#d29922}
btn,button,select{cursor:pointer}
.btn{padding:3px 9px;border:1px solid #30363d;border-radius:4px;background:#21262d;color:#c9d1d9;font-size:.75rem}
.btn:hover{background:#30363d}
.btn.on{background:#1f6feb;border-color:#388bfd;color:#fff}
.btn.red{border-color:#f85149;color:#f85149}
.btn.red:hover{background:#f85149;color:#fff}
.btn.grn{border-color:#3fb950;color:#3fb950}
.btn.grn:hover{background:#3fb950;color:#000}
.moderow{display:grid;grid-template-columns:1fr 1fr 1fr;gap:5px;margin-bottom:8px}
.mbtn{padding:7px 4px;text-align:center;border:1px solid #30363d;border-radius:4px;background:#21262d;color:#8b949e;font-size:.78rem}
.mbtn.on{background:#1f6feb;border-color:#388bfd;color:#fff}
.toolrow{display:grid;grid-template-columns:1fr 1f;gap:5px}
.tbtn{padding:6px;text-align:center;border:1px solid #30363d;border-radius:4px;background:#21262d;color:#8b949e;font-size:.78rem}
.tbtn.on{background:#3fb95033;border-color:#3fb950;color:#3fb950}
input[type=text],input[type=number],select{background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:5px 9px;border-radius:4px;font-size:.82rem;width:100%;margin-bottom:6px}
.chat{display:flex;flex-direction:column;height:calc(100vh - 108px)}
.msgs{flex:1;overflow-y:auto;background:#0d1117;border:1px solid #30363d;border-radius:6px;padding:10px;margin-bottom:8px;font-size:.83rem;line-height:1.5}
.msg{margin-bottom:9px;padding:7px 10px;border-radius:5px}
.msg.user{background:#1f6feb18;border-left:3px solid #58a6ff}
.msg.assistant{background:#3fb95018;border-left:3px solid #3fb950}
.msg.system{background:#f8514918;border-left:3px solid #f85149;font-style:italic;color:#8b949e}
.msg.tool{background:#d2992218;border-left:3px solid #d29922;font-family:monospace;font-size:.78rem}
.mlabel{font-size:.68rem;color:#8b949e;margin-bottom:3px;font-weight:600;text-transform:uppercase}
.mcontent{white-space:pre-wrap;word-break:break-word}
.inputrow{display:flex;gap:7px}
.inputrow textarea{flex:1;background:#0d1117;border:1px solid #30363d;color:#c9d1d9;padding:7px 11px;border-radius:6px;resize:none;font-size:.88rem;font-family:inherit;height:56px}
.approvebar{background:#d2992218;border:1px solid #d29922;border-radius:6px;padding:9px 12px;margin-bottom:8px;display:none}
.approvebar.show{display:block}
</style>
</head>
<body>
<div class="topbar">
  <div id="dot"></div>
  <h1>AI-Meeting</h1>
  <span id="statusTxt"></span>
  <button class="btn red" id="killBtn" style="display:none" onclick="killSession()">Kill Session</button>
</div>
<div id="banner" class="banner"></div>
<div class="layout">
  <!-- LEFT COLUMN -->
  <div class="col">
    <!-- Models -->
    <div class="card">
      <h2>Models</h2>
      <div id="modelList"></div>
      <details style="margin-top:10px">
        <summary style="font-size:.8rem;color:#8b949e;cursor:pointer">Add / Update Model</summary>
        <div style="margin-top:8px">
          <input type="text" id="nId" placeholder="id">
          <select id="nBackend"><option value="ollama">ollama</option><option value="openrouter">openrouter</option></select>
          <input type="text" id="nTarget" placeholder="target model name">
          <input type="text" id="nName" placeholder="display name (optional)">
          <select id="nRole"><option value="developer">developer</option><option value="researcher">researcher</option><option value="supervisor">supervisor</option></select>
          <button class="btn grn" style="width:100%" onclick="upsertModel()">Save</button>
        </div>
      </details>
    </div>
    <!-- Mode -->
    <div class="card">
      <h2>Mode</h2>
      <div class="moderow" id="modeRow"></div>
      <div id="modeExtra"></div>
    </div>
    <!-- Tools -->
    <div class="card">
      <h2>Tools <span style="font-size:.7rem;color:#8b949e">(autonomous)</span></h2>
      <div class="toolrow" id="toolRow" style="grid-template-columns:1fr 1fr;gap:5px"></div>
      <div style="margin-top:8px">
        <label style="font-size:.75rem;color:#8b949e">Max iterations</label>
        <input type="number" id="maxIter" value="20" min="1" max="200" onchange="setMaxIter(this.value)">
      </div>
    </div>
  </div>
  <!-- RIGHT COLUMN: chat -->
  <div class="card" style="display:flex;flex-direction:column">
    <h2 id="chatTitle">Chat</h2>
    <div id="approveBar" class="approvebar">
      <div id="approveMsg" style="font-size:.83rem;margin-bottom:7px"></div>
      <div style="display:flex;gap:7px">
        <button class="btn grn" onclick="resolveApproval(true)">Approve</button>
        <button class="btn red" onclick="resolveApproval(false)">Deny</button>
      </div>
    </div>
    <div class="msgs" id="msgs"></div>
    <input type="text" id="sysPrompt" placeholder="System prompt (optional)" style="margin-bottom:7px">
    <div class="inputrow">
      <textarea id="userIn" placeholder="Type a message… (Enter to send, Shift+Enter for newline)"
        onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMsg()}"></textarea>
      <button class="btn on" style="padding:0 18px;height:56px;font-size:.9rem" onclick="sendMsg()">Send</button>
    </div>
  </div>
</div>
<script>
let S = {};

async function api(path, body){
  const r = await fetch(path, body
    ? {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}
    : {method:'GET'});
  return r.json();
}

async function refresh(){
  S = await api('/status');
  document.getElementById('banner').textContent = S.banner || '';
  document.getElementById('maxIter').value = S.autonomous?.max_iter || 20;
  renderModels();
  renderMode();
  renderTools();
  const sess = await api('/session');
  renderSession(sess);
}

function renderModels(){
  document.getElementById('modelList').innerHTML = S.models.map(m => \`
    <div class="mcard \${m.enabled?'':'off'}">
      <div style="display:flex;justify-content:space-between;align-items:center">
        <span class="mname">\${esc(m.name||m.id)}</span>
        <span class="tag \${m.role}">\${m.role}</span>
      </div>
      <div class="mmeta">\${m.backend} · \${esc(m.target)}</div>
      \${S.active_model===m.id?'<div class="mmeta" style="color:#58a6ff">● active</div>':''}
      \${S.supervisor_id===m.id?'<div class="mmeta" style="color:#d29922">★ supervisor</div>':''}
      <div class="mactions">
        <button class="btn \${m.enabled?'on':''}" onclick="toggleModel('\${m.id}',\${!m.enabled})">\${m.enabled?'On':'Off'}</button>
        <button class="btn" onclick="setActive('\${m.id}')">Active</button>
        <button class="btn" onclick="setSupervisor('\${m.id}')">\${S.supervisor_id===m.id?'Unsup':'Supervisor'}</button>
        <select onchange="setRole('\${m.id}',this.value)" style="width:auto;margin:0;padding:3px 6px;font-size:.72rem">
          \${['developer','researcher','supervisor'].map(r=>\`<option \${m.role===r?'selected':''} value="\${r}">\${r}</option>\`).join('')}
        </select>
      </div>
    </div>
  \`).join('');
}

function renderMode(){
  const modes=['single','multi','supervisor','debate','autonomous'];
  document.getElementById('modeRow').innerHTML = modes.map(m=>
    \`<div class="mbtn \${S.mode===m?'on':''}" onclick="setMode('\${m}')">\${m}</div>\`
  ).join('');
  let extra = '';
  if(S.mode==='debate'){
    const ms = S.models;
    extra = \`<div style="font-size:.78rem;color:#8b949e;margin-bottom:5px">Debate settings</div>
      <label style="font-size:.72rem;color:#8b949e">Rounds</label>
      <input type="number" value="\${S.debate?.rounds||3}" min="1" max="10" onchange="setDebateRounds(this.value)">
      <label style="font-size:.72rem;color:#8b949e">Model A</label>
      <select onchange="setDebateModel('a',this.value)">\${ms.map(m=>\`<option \${S.debate?.model_a===m.id?'selected':''} value="\${m.id}">\${esc(m.name||m.id)}</option>\`).join('')}</select>
      <label style="font-size:.72rem;color:#8b949e">Model B</label>
      <select onchange="setDebateModel('b',this.value)">\${ms.map(m=>\`<option \${S.debate?.model_b===m.id?'selected':''} value="\${m.id}">\${esc(m.name||m.id)}</option>\`).join('')}</select>\`;
  }
  document.getElementById('modeExtra').innerHTML = extra;
}

function renderTools(){
  const names=['run_shell','read_file','write_file','http_fetch'];
  document.getElementById('toolRow').innerHTML = names.map(t=>
    \`<div class="tbtn \${S.autonomous?.tools?.[t]?'on':''}" onclick="toggleTool('\${t}')">\${t}</div>\`
  ).join('');
}

function renderSession(sess){
  const dot=document.getElementById('dot');
  const txt=document.getElementById('statusTxt');
  const kill=document.getElementById('killBtn');
  const abar=document.getElementById('approveBar');

  if(sess.running){
    dot.className='on'; txt.textContent=\`running · iter \${sess.iter}\`; kill.style.display='block';
  } else {
    dot.className=''; txt.textContent=''; kill.style.display='none';
  }

  if(sess.paused){
    const p=[...sess.log].reverse().find(l=>l.content?.includes('PAUSED'));
    abar.className='approvebar show';
    document.getElementById('approveMsg').textContent=p?.content||'Tool approval required';
  } else {
    abar.className='approvebar';
  }

  if(sess.log?.length){
    const el=document.getElementById('msgs');
    el.innerHTML=sess.log.map(m=>\`
      <div class="msg \${m.role}">
        <div class="mlabel">\${m.role}\${m.tool_call_id?' [tool result]':''}</div>
        <div class="mcontent">\${esc(m.content||JSON.stringify(m.tool_calls||''))}</div>
      </div>\`).join('');
    el.scrollTop=el.scrollHeight;
  }
}

function esc(s){
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function sendMsg(){
  const inp=document.getElementById('userIn');
  const msg=inp.value.trim(); if(!msg) return;
  inp.value='';
  const sys=document.getElementById('sysPrompt').value.trim();
  const el=document.getElementById('msgs');
  el.innerHTML+=\`<div class="msg user"><div class="mlabel">you</div><div class="mcontent">\${esc(msg)}</div></div>\`;
  el.scrollTop=el.scrollHeight;
  try{
    const body={message:msg};
    if(sys) body.system=sys;
    const r=await api('/chat',body);
    if(r.reply){
      el.innerHTML+=\`<div class="msg assistant"><div class="mlabel">\${r.model_used||'assistant'} [\${r.mode}]</div><div class="mcontent">\${esc(r.reply)}</div></div>\`;
    } else if(r.replies){
      r.replies.forEach(rep=>{
        el.innerHTML+=\`<div class="msg assistant"><div class="mlabel">\${rep.id} [multi]</div><div class="mcontent">\${esc(rep.reply)}</div></div>\`;
      });
    } else if(r.verdict!==undefined){
      (r.log||[]).forEach(l=>{
        el.innerHTML+=\`<div class="msg assistant"><div class="mlabel">\${l.model} [debate r\${l.round}]</div><div class="mcontent">\${esc(l.content)}</div></div>\`;
      });
      el.innerHTML+=\`<div class="msg assistant"><div class="mlabel">\${r.supervisor_used||'supervisor'} [verdict]</div><div class="mcontent">\${esc(r.verdict)}</div></div>\`;
    } else if(r.started){
      el.innerHTML+=\`<div class="msg system"><div class="mlabel">system</div><div class="mcontent">Autonomous session started…</div></div>\`;
    } else if(r.error){
      el.innerHTML+=\`<div class="msg system"><div class="mlabel">error</div><div class="mcontent">\${esc(r.error)}</div></div>\`;
    }
    el.scrollTop=el.scrollHeight;
  }catch(e){
    el.innerHTML+=\`<div class="msg system"><div class="mlabel">error</div><div class="mcontent">\${esc(e.message)}</div></div>\`;
  }
  refresh();
}

async function toggleModel(id,enabled){ await api('/models/toggle',{id,enabled}); refresh(); }
async function setActive(id){ await api('/mode',{active_model:id}); refresh(); }
async function setSupervisor(id){ await api('/supervisor',{id: S.supervisor_id===id ? null : id}); refresh(); }
async function setRole(id,role){ await api('/models/role',{id,role}); refresh(); }
async function setMode(mode){ await api('/mode',{mode}); refresh(); }
async function setDebateRounds(v){ await api('/mode',{debate:{...S.debate,rounds:parseInt(v)}}); }
async function setDebateModel(which,id){ await api('/mode',{debate:{...S.debate,[which==='a'?'model_a':'model_b']:id}}); }
async function toggleTool(tool){ await api('/tools/toggle',{tool,enabled:!S.autonomous?.tools?.[tool]}); refresh(); }
async function setMaxIter(v){ await api('/mode',{autonomous:{...S.autonomous,max_iter:parseInt(v)}}); }
async function upsertModel(){
  const id=document.getElementById('nId').value.trim();
  const backend=document.getElementById('nBackend').value;
  const target=document.getElementById('nTarget').value.trim();
  const name=document.getElementById('nName').value.trim();
  const role=document.getElementById('nRole').value;
  if(!id||!target) return alert('ID and target are required');
  await api('/models/upsert',{id,backend,target,name,role});
  refresh();
}
async function killSession(){ await api('/session/kill',{}); refresh(); }
async function resolveApproval(approved){ await api('/session/approve',{approved}); refresh(); }

refresh();
setInterval(()=>fetch('/session').then(r=>r.json()).then(renderSession).catch(()=>{}), 2000);
</script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------
const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const path = parsed.pathname;
  const method = req.method;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,x-relay-key');
  if (method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── GET endpoints (no auth) ───────────────────────────────────────────────
  if (method === 'GET' && path === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(dashboardHTML());
    return;
  }

  if (method === 'GET' && path === '/status') {
    sendJSON(res, registry);
    return;
  }

  if (method === 'GET' && path === '/models') {
    sendJSON(res, registry.models);
    return;
  }

  if (method === 'GET' && path === '/session') {
    sendJSON(res, {
      running: session.running,
      paused: session.paused,
      iter: session.iter,
      log: session.log
    });
    return;
  }

  // ── POST endpoints (auth required if RELAY_SECRET set) ───────────────────
  if (method !== 'POST') { sendJSON(res, { error: 'Not found' }, 404); return; }

  if (!checkAuth(req)) { sendJSON(res, { error: 'Unauthorized' }, 401); return; }

  let body = {};
  try { body = await parseBody(req); } catch { sendJSON(res, { error: 'Invalid JSON' }, 400); return; }

  // POST /chat
  if (path === '/chat') {
    const { message, model: modelId, mode, system } = body;
    if (!message) { sendJSON(res, { error: 'message required' }, 400); return; }

    const activeMode = mode || registry.mode;
    const messages = [];
    if (system) messages.push({ role: 'system', content: system });
    messages.push({ role: 'user', content: message });

    try {
      if (activeMode === 'autonomous') {
        if (session.running) { sendJSON(res, { error: 'Session already running' }, 409); return; }
        session.running = true;
        session.log = [];
        session.paused = false;
        session.iter = 0;
        modeAutonomous(system || '', message).catch(e => {
          session.log.push({ role: 'system', content: 'Fatal: ' + e.message });
          session.running = false;
        });
        sendJSON(res, { started: true, mode: 'autonomous' });
      } else if (activeMode === 'multi') {
        sendJSON(res, await modeMulti(messages));
      } else if (activeMode === 'supervisor') {
        sendJSON(res, await modeSupervisor(messages));
      } else if (activeMode === 'debate') {
        sendJSON(res, await modeDebate(messages));
      } else {
        sendJSON(res, await modeSingle(messages, modelId));
      }
    } catch (e) {
      sendJSON(res, { error: e.message }, 500);
    }
    return;
  }

  // POST /models/toggle
  if (path === '/models/toggle') {
    const m = getModel(body.id);
    if (!m) { sendJSON(res, { error: 'Model not found' }, 404); return; }
    m.enabled = !!body.enabled;
    sendJSON(res, { ok: true, model: m });
    return;
  }

  // POST /models/role
  if (path === '/models/role') {
    const m = getModel(body.id);
    if (!m) { sendJSON(res, { error: 'Model not found' }, 404); return; }
    m.role = body.role;
    sendJSON(res, { ok: true, model: m });
    return;
  }

  // POST /models/upsert
  if (path === '/models/upsert') {
    if (!body.id || !body.backend || !body.target) {
      sendJSON(res, { error: 'id, backend, and target are required' }, 400); return;
    }
    const existing = getModel(body.id);
    if (existing) {
      Object.assign(existing, {
        backend: body.backend,
        target: body.target,
        name: body.name || existing.name,
        role: body.role || existing.role
      });
      sendJSON(res, { ok: true, model: existing });
    } else {
      const nm = {
        id: body.id, backend: body.backend, target: body.target,
        name: body.name || body.id, role: body.role || 'developer', enabled: true
      };
      registry.models.push(nm);
      sendJSON(res, { ok: true, model: nm });
    }
    return;
  }

  // POST /mode
  if (path === '/mode') {
    if (body.mode !== undefined) registry.mode = body.mode;
    if (body.active_model !== undefined) registry.active_model = body.active_model;
    if (body.supervisor_id !== undefined) registry.supervisor_id = body.supervisor_id;
    if (body.debate !== undefined) Object.assign(registry.debate, body.debate);
    if (body.autonomous !== undefined) Object.assign(registry.autonomous, body.autonomous);
    sendJSON(res, { ok: true });
    return;
  }

  // POST /supervisor
  if (path === '/supervisor') {
    registry.supervisor_id = body.id || null;
    sendJSON(res, { ok: true });
    return;
  }

  // POST /tools/toggle
  if (path === '/tools/toggle') {
    if (!(body.tool in registry.autonomous.tools)) {
      sendJSON(res, { error: 'Unknown tool: ' + body.tool }, 400); return;
    }
    registry.autonomous.tools[body.tool] = !!body.enabled;
    sendJSON(res, { ok: true });
    return;
  }

  // POST /session/approve
  if (path === '/session/approve') {
    if (session._pauseResolve) {
      session._pauseResolve(!!body.approved);
      session._pauseResolve = null;
    }
    sendJSON(res, { ok: true });
    return;
  }

  // POST /session/kill
  if (path === '/session/kill') {
    session.kill = true;
    if (session._pauseResolve) { session._pauseResolve(false); session._pauseResolve = null; }
    sendJSON(res, { ok: true });
    return;
  }

  sendJSON(res, { error: 'Not found' }, 404);
});

server.listen(PORT, () => {
  console.log(`AI-Meeting server listening on port ${PORT}`);
  console.log(`Dashboard → http://localhost:${PORT}`);
  if (!RELAY_SECRET) console.warn('WARNING: RELAY_SECRET not set — /chat endpoint is unprotected');
  if (!OPENROUTER_KEY) console.log('INFO: OPENROUTER_KEY not set — OpenRouter models disabled');
});
