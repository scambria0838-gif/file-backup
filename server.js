// Multi-Model AI Orchestrator - Stage 6
// Adds over Stage 5:
//   1. Disk-backed persistent session state (survives restarts)
//   2. Correct tool_call_id + name on every tool-result message (OpenAI & Ollama)
//   3. Simultaneous OpenRouter + Ollama backend support without response clobbering
//   4. Session recovery, /session/history and /session/reset endpoints
// Run: RELAY_SECRET=yoursecret OPENROUTER_KEY=sk-or-... node server.js

import http from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";

// ---------- config ----------
const PORT           = process.env.PORT           || 8080;
const OLLAMA_URL     = process.env.OLLAMA_URL      || "http://localhost:11434";
const RELAY_SECRET   = process.env.RELAY_SECRET    || "change-me";
const OPENROUTER_KEY = process.env.OPENROUTER_KEY  || "";
const OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions";
const SESSION_FILE   = process.env.SESSION_FILE    || ".session.json";
const MAX_LOG        = 200;   // entries to keep in session log

// ---------- tool registry ----------
const toolRegistry = {
  run_shell: {
    enabled: false,
    description: "Execute a shell command and return stdout/stderr.",
    params: { command: "string" },
    async run({ command }) {
      return new Promise(resolve => {
        const child = spawn("bash", ["-c", command]);
        let stdout = "", stderr = "";
        const t = setTimeout(() => child.kill("SIGKILL"), 30_000);
        child.stdout.on("data", d => stdout += d);
        child.stderr.on("data", d => stderr += d);
        child.on("close", code => { clearTimeout(t); resolve({ exit_code: code, stdout: stdout.slice(-6000), stderr: stderr.slice(-2000) }); });
        child.on("error", e => resolve({ exit_code: -1, stdout: "", stderr: String(e) }));
      });
    },
  },
  read_file: {
    enabled: false,
    description: "Read the contents of a file at the given path.",
    params: { path: "string" },
    async run({ path }) {
      try { return { content: (await readFile(path, "utf8")).slice(0, 20_000) }; }
      catch (e) { return { error: String(e.message) }; }
    },
  },
  write_file: {
    enabled: false,
    description: "Write content to a file at the given path (creates or overwrites).",
    params: { path: "string", content: "string" },
    async run({ path, content }) {
      try { await writeFile(path, content, "utf8"); return { ok: true, path }; }
      catch (e) { return { error: String(e.message) }; }
    },
  },
  http_fetch: {
    enabled: false,
    description: "Make an HTTP GET request to a URL and return the response body.",
    params: { url: "string" },
    async run({ url }) {
      try {
        const r = await fetch(url);
        const text = (await r.text()).slice(0, 10_000);
        return { status: r.status, body: text };
      } catch (e) { return { error: String(e.message) }; }
    },
  },
};

function enabledTools() {
  return Object.entries(toolRegistry)
    .filter(([, t]) => t.enabled)
    .map(([name, t]) => ({
      type: "function",
      function: {
        name,
        description: t.description,
        parameters: {
          type: "object",
          properties: Object.fromEntries(Object.entries(t.params).map(([k, v]) => [k, { type: v }])),
          required: Object.keys(t.params),
        },
      },
    }));
}

// ---------- model registry ----------
const registry = {
  models: [
    { id: "qwen",        name: "Qwen 2.5 Abliterated",            backend: "ollama",      target: "huihui_ai/qwen2.5-abliterate:latest",      role: "developer",  enabled: true },
    { id: "llama-small", name: "Llama 3.2 1B Abliterated",        backend: "ollama",      target: "huihui_ai/llama3.2-abliterate:1b",         role: "researcher", enabled: true },
    { id: "or-llama70b", name: "OpenRouter Llama 3.3 70B Instruct", backend: "openrouter", target: "meta-llama/llama-3.3-70b-instruct",        role: "supervisor", enabled: false },
  ],
  mode: "single",
  active_model: "qwen",
  supervisor_id: null,
  multi_members: [],
  debate: { rounds: 2, participants: [] },
  autonomous: { model: "qwen", max_iterations: 10 },
};

const VALID_ROLES = ["supervisor","architect","planner","researcher","developer","critic","reviewer","memory_manager","autonomous_agent"];
const VALID_MODES = ["single","multi","supervisor","debate","autonomous"];

// ---------- backends ----------
//
// Both callOllama and callOpenRouter return the SAME normalized shape:
//   { message: { role, content, tool_calls? }, finish_reason }
// tool_calls items always carry an `id` (generated for Ollama if absent).
//
function generateToolCallId() {
  return `call_${randomBytes(5).toString("hex")}`;
}

function normalizeToolCalls(rawCalls) {
  if (!rawCalls || !rawCalls.length) return undefined;
  return rawCalls.map(tc => ({
    id:       tc.id || generateToolCallId(),   // Ollama ≤0.3 omits id
    type:     tc.type || "function",
    function: {
      name: tc.function?.name ?? "",
      // Ollama may give arguments as an object; OpenAI gives a JSON string.
      arguments: typeof tc.function?.arguments === "string"
        ? tc.function.arguments
        : JSON.stringify(tc.function?.arguments ?? {}),
    },
  }));
}

const backends = {
  async ollama(model, messages, tools) {
    const body = { model: model.target, messages, stream: false };
    if (tools && tools.length) body.tools = tools;
    const r = await fetch(`${OLLAMA_URL}/api/chat`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`ollama ${r.status}: ${await r.text()}`);
    const out = await r.json();
    const msg = out.message || { role: "assistant", content: "" };
    const calls = normalizeToolCalls(msg.tool_calls);
    return {
      message:       { role: msg.role || "assistant", content: msg.content ?? "", ...(calls ? { tool_calls: calls } : {}) },
      finish_reason: out.done_reason || (calls ? "tool_calls" : "stop"),
    };
  },

  async openrouter(model, messages, tools) {
    if (!OPENROUTER_KEY) throw new Error("OPENROUTER_KEY not set");
    const body = { model: model.target, messages, stream: false };
    if (tools && tools.length) body.tools = tools;
    const r = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "authorization": `Bearer ${OPENROUTER_KEY}` },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`openrouter ${r.status}: ${await r.text()}`);
    const out = await r.json();
    const choice = out.choices?.[0] ?? {};
    const msg = choice.message ?? { role: "assistant", content: "" };
    const calls = normalizeToolCalls(msg.tool_calls);
    return {
      message:       { role: msg.role || "assistant", content: msg.content ?? "", ...(calls ? { tool_calls: calls } : {}) },
      finish_reason: choice.finish_reason || (calls ? "tool_calls" : "stop"),
    };
  },
};

async function callBackend(modelId, messages, tools) {
  const m = registry.models.find(x => x.id === modelId);
  if (!m || !m.enabled) throw new Error(`model unavailable: ${modelId}`);
  return backends[m.backend](m, messages, tools);
}

async function runModel(modelId, messages) {
  const { message } = await callBackend(modelId, messages, []);
  return message.content ?? "";
}

// ---------- persistent session state ----------
//
// Persisted fields:  id, createdAt, running, killed, log, messages, pendingApprovalData
// Live-only fields:  _pendingResolve (the Promise resolver for the current approval gate)
//
let sess = freshSession();
let _pendingResolve = null;   // NOT persisted — cannot survive restarts

function freshSession() {
  return {
    id:                  `sess_${randomBytes(4).toString("hex")}`,
    createdAt:           new Date().toISOString(),
    running:             false,
    killed:              false,
    log:                 [],
    messages:            [],   // autonomous agent full history
    pendingApprovalData: null, // { toolName, args } — survives disk write
  };
}

async function loadSession() {
  try {
    await access(SESSION_FILE);
    const raw = await readFile(SESSION_FILE, "utf8");
    sess = JSON.parse(raw);
    // If server restarted while agent was running, mark the session as killed
    // so the UI reflects the true state and the user can restart cleanly.
    if (sess.running) {
      sess.running = false;
      sess.killed  = true;
      sess.pendingApprovalData = null;
      sess.log.push({ type: "restart_killed", ts: new Date().toISOString(),
        message: "Server restarted while agent was running." });
      await persistSession();
      console.log("[session] Previous running session terminated by restart.");
    } else {
      console.log(`[session] Loaded session ${sess.id} (${sess.messages.length} messages, ${sess.log.length} log entries).`);
    }
  } catch {
    console.log("[session] No saved session — starting fresh.");
  }
}

async function persistSession() {
  try {
    await writeFile(SESSION_FILE, JSON.stringify(sess, null, 2), "utf8");
  } catch (e) {
    console.error("[session] Persist failed:", e.message);
  }
}

function sessionLog(entry) {
  sess.log.push({ ...entry, ts: new Date().toISOString() });
  if (sess.log.length > MAX_LOG) sess.log = sess.log.slice(-MAX_LOG);
}

function sessionSnapshot() {
  return {
    id:           sess.id,
    running:      sess.running,
    killed:       sess.killed,
    pending:      (_pendingResolve && sess.pendingApprovalData) ? sess.pendingApprovalData : null,
    log:          sess.log.slice(-100),
    messageCount: sess.messages.length,
  };
}

// ---------- non-autonomous modes (unchanged from Stage 5) ----------
function membersForRun() {
  const list = registry.multi_members.length > 0 ? registry.multi_members : registry.models.filter(m => m.enabled).map(m => m.id);
  return list.filter(id => { const m = registry.models.find(x => x.id === id); return m && m.enabled && id !== registry.supervisor_id; });
}
async function runSingle(messages, override) {
  const id = override || registry.active_model;
  return { reply: await runModel(id, messages), model_used: id, mode: "single" };
}
async function runMulti(messages) {
  const ids = membersForRun();
  if (!ids.length) throw new Error("no enabled participants");
  const results = await Promise.all(ids.map(async id => { try { return { id, reply: await runModel(id, messages) }; } catch(e) { return { id, error: String(e.message) }; } }));
  return { reply: results.map(r => `### ${r.id}\n${r.reply ?? `[error: ${r.error}]`}`).join("\n\n"), model_used: ids, mode: "multi", per_model: results };
}
async function runSupervised(messages) {
  if (!registry.supervisor_id) throw new Error("no supervisor assigned");
  const sup = registry.models.find(m => m.id === registry.supervisor_id);
  if (!sup || !sup.enabled) throw new Error("supervisor missing or disabled");
  const ids = membersForRun();
  if (!ids.length) throw new Error("no participants besides supervisor");
  const drafts = await Promise.all(ids.map(async id => { try { return { id, reply: await runModel(id, messages) }; } catch(e) { return { id, error: String(e.message) }; } }));
  const userPrompt = messages[messages.length-1]?.content || "";
  const draftBlock = drafts.map(d => `--- ${d.id} ---\n${d.reply ?? `[error: ${d.error}]`}`).join("\n\n");
  const supMessages = [
    { role:"system", content:"You are the Supervisor. Review candidate answers, identify the best points, correct errors, and produce one consolidated final answer." },
    { role:"user", content:`User question:\n${userPrompt}\n\nCandidates:\n${draftBlock}\n\nProduce the single best final answer.` },
  ];
  return { reply: await runModel(sup.id, supMessages), model_used: sup.id, mode: "supervisor", drafts, supervisor: sup.id };
}
async function runDebate(messages) {
  let participants = registry.debate.participants;
  if (!participants || participants.length < 2) participants = registry.models.filter(m => m.enabled).slice(0,2).map(m => m.id);
  if (participants.length < 2) throw new Error("debate needs at least two participants");
  const [aId, bId] = participants;
  const rounds = Math.max(1, Math.min(8, registry.debate.rounds || 2));
  const userPrompt = messages[messages.length-1]?.content || "";
  const transcript = [];
  let lastA = "", lastB = "";
  for (let i = 0; i < rounds; i++) {
    lastA = await runModel(aId, [
      { role:"system", content:`You are debater A (${aId}). ${i===0?"Open with your strongest case.":"Respond to debater B and strengthen your position."}` },
      { role:"user", content:`Topic:\n${userPrompt}${lastB?`\n\nDebater B said:\n${lastB}`:""}` },
    ]);
    transcript.push({ round: i+1, speaker: aId, text: lastA });
    lastB = await runModel(bId, [
      { role:"system", content:`You are debater B (${bId}). Take the opposing view. Counter debater A directly.` },
      { role:"user", content:`Topic:\n${userPrompt}\n\nDebater A said:\n${lastA}` },
    ]);
    transcript.push({ round: i+1, speaker: bId, text: lastB });
  }
  let verdict = null;
  if (registry.supervisor_id) {
    const sup = registry.models.find(m => m.id === registry.supervisor_id);
    if (sup && sup.enabled) {
      const log = transcript.map(t => `[Round ${t.round} – ${t.speaker}]\n${t.text}`).join("\n\n");
      verdict = await runModel(sup.id, [
        { role:"system", content:"You are the Supervisor. Read the debate and produce a balanced verdict: what each side got right, what they got wrong, and the best answer." },
        { role:"user", content:`Original question:\n${userPrompt}\n\nTranscript:\n${log}` },
      ]);
    }
  }
  const replyText = verdict
    ? `## Verdict (${registry.supervisor_id})\n${verdict}\n\n---\n## Transcript\n${transcript.map(t=>`**Round ${t.round} — ${t.speaker}:**\n${t.text}`).join("\n\n")}`
    : transcript.map(t=>`**Round ${t.round} — ${t.speaker}:**\n${t.text}`).join("\n\n");
  return { reply: replyText, mode:"debate", participants, rounds, transcript, verdict, supervisor: registry.supervisor_id||null };
}

// ---------- autonomous mode ----------
//
// Key invariant for tool_call_id correctness:
//   After the assistant message is added to history, ALL tool-result messages
//   for that turn must be added before the next model call. Each result carries:
//     role: "tool"  +  tool_call_id: <matching assistant tool_calls[i].id>  +  name: <tool>
//   The `name` field is required by several OpenRouter-hosted models.
//
async function runAutonomous(userPrompt) {
  if (sess.running) throw new Error("a session is already running — kill it first");

  // Start fresh autonomous session (preserves the sess.id & log history)
  sess.running = true;
  sess.killed  = false;
  sess.pendingApprovalData = null;
  sess.messages = [
    { role: "system", content:
        "You are an autonomous agent. Complete the user's task using the available tools. " +
        "Think step by step. When the task is fully done, respond with a plain text final answer and no tool calls." },
    { role: "user", content: userPrompt },
  ];
  _pendingResolve = null;

  const modelId = registry.autonomous.model;
  const maxIter = registry.autonomous.max_iterations || 10;
  const tools   = enabledTools();

  sessionLog({ type: "start", model: modelId, max_iterations: maxIter, tools: tools.map(t => t.function.name) });
  await persistSession();

  // Fire-and-forget background loop; caller gets 202 immediately.
  (async () => {
    try {
      for (let i = 0; i < maxIter; i++) {
        if (sess.killed) { sessionLog({ type: "killed", iteration: i }); break; }

        // ── call the model ──
        let out;
        try { out = await callBackend(modelId, sess.messages, tools); }
        catch (e) { sessionLog({ type: "error", message: String(e.message || e) }); break; }

        const { message, finish_reason } = out;

        // Persist the assistant turn immediately so history is coherent
        // even if execution is interrupted during tool handling.
        sess.messages.push(message);
        await persistSession();

        const calls = message.tool_calls;

        // ── no tool calls → final answer ──
        if (!calls || !calls.length) {
          sessionLog({ type: "done", iteration: i, reply: message.content || "" });
          await persistSession();
          break;
        }

        // ── execute each tool call and collect results ──
        // Collect ALL results before pushing to history so that the provider
        // sees a complete set of tool results in a single history update.
        const resultMessages = [];

        for (const call of calls) {
          if (sess.killed) break;

          const name        = call.function?.name;
          const toolCallId  = call.id;   // always present after normalizeToolCalls()
          const args        = JSON.parse(call.function?.arguments || "{}");
          const tool        = toolRegistry[name];

          // ── pause for human approval if tool is disabled ──
          if (!tool || !tool.enabled) {
            sess.pendingApprovalData = { toolName: name, args, toolCallId };
            sessionLog({ type: "paused", reason: `tool not enabled: ${name}`, args, toolCallId });
            await persistSession();

            const approved = await new Promise(resolve => { _pendingResolve = resolve; });
            _pendingResolve = null;
            sess.pendingApprovalData = null;

            if (!approved) {
              resultMessages.push(toolResult(toolCallId, name, { error: `tool '${name}' was denied by operator` }));
              sessionLog({ type: "tool_denied", name, args, toolCallId });
              continue;
            }
            // One-time approval — run but don't permanently enable
          }

          sessionLog({ type: "tool_call", iteration: i, name, args, toolCallId });

          let result;
          try   { result = await toolRegistry[name].run(args); }
          catch (e) { result = { error: String(e.message) }; }

          sessionLog({ type: "tool_result", name, result, toolCallId });
          resultMessages.push(toolResult(toolCallId, name, result));
        }

        // Push all results in one batch, then persist once.
        sess.messages.push(...resultMessages);
        await persistSession();

        if (finish_reason === "stop") break;
      }
    } catch (e) {
      sessionLog({ type: "error", message: String(e.message || e) });
      await persistSession();
    } finally {
      sess.running = false;
      sess.pendingApprovalData = null;
      _pendingResolve = null;
      await persistSession();
    }
  })();

  return { started: true, model: modelId, max_iterations: maxIter, tools: tools.map(t => t.function.name), session_id: sess.id };
}

// Build a correctly-linked tool-result message.
// `name` is included for OpenRouter models that require it.
function toolResult(toolCallId, name, result) {
  return {
    role:         "tool",
    tool_call_id: toolCallId,
    name,
    content:      JSON.stringify(result),
  };
}

// ---------- status ----------
function statusSnapshot() {
  const supervisor = registry.supervisor_id ? registry.models.find(m => m.id === registry.supervisor_id) : null;
  return {
    stage: 6,
    mode: registry.mode,
    active_model: registry.active_model,
    multi_members: registry.multi_members,
    debate: registry.debate,
    autonomous: registry.autonomous,
    supervisor: supervisor ? { id: supervisor.id, name: supervisor.name } : null,
    banner: supervisor
      ? { color: "green", text: "SUPERVISOR ACTIVE" }
      : { color: "red",   text: "INDEPENDENT AGENT MODE ACTIVE" },
    models: registry.models.map(m => ({ id:m.id, name:m.name, role:m.role, enabled:m.enabled, backend:m.backend, target:m.target })),
    tools: Object.fromEntries(Object.entries(toolRegistry).map(([k,v]) => [k, { enabled:v.enabled, description:v.description }])),
    valid_roles: VALID_ROLES,
    valid_modes: VALID_MODES,
    openrouter_configured: !!OPENROUTER_KEY,
    session_file: SESSION_FILE,
  };
}

// ---------- HTTP helpers ----------
const routes = {};
function route(method, path, handler, opts={}) { routes[`${method} ${path}`] = { handler, opts }; }
function send(res, status, obj) { res.statusCode=status; res.setHeader("content-type","application/json"); res.end(JSON.stringify(obj,null,2)); }
function sendHtml(res, html) { res.statusCode=200; res.setHeader("content-type","text/html; charset=utf-8"); res.end(html); }
async function readJson(req) { let b=""; for await(const c of req) b+=c; if(!b) return {}; try { return JSON.parse(b); } catch { return {}; } }
function auth(req) { return req.headers["x-relay-key"] === RELAY_SECRET; }

// ---------- routes ----------
route("GET", "/",       async (req,res) => sendHtml(res, DASHBOARD_HTML), { public:true });
route("GET", "/status", async (req,res) => send(res, 200, statusSnapshot()));
route("GET", "/models", async (req,res) => send(res, 200, { models: registry.models }));
route("GET", "/session", async (req,res) => send(res, 200, sessionSnapshot()));

// Full message history — useful for debugging or UI replay
route("GET", "/session/history", async (req,res) => send(res, 200, { session_id: sess.id, messages: sess.messages }));

// Clear session history and start a new session id
route("POST", "/session/reset", async (req,res) => {
  if (sess.running) return send(res, 409, { error: "kill the running session first" });
  sess = freshSession();
  await persistSession();
  send(res, 200, { reset: true, session_id: sess.id });
});

route("POST", "/models/toggle", async (req,res) => {
  const b = await readJson(req);
  const m = registry.models.find(x => x.id === b.id);
  if (!m) return send(res, 404, { error: "unknown model" });
  m.enabled = !!b.enabled;
  send(res, 200, statusSnapshot());
});
route("POST", "/models/role", async (req,res) => {
  const b = await readJson(req);
  if (!VALID_ROLES.includes(b.role)) return send(res, 400, { error: "invalid role", valid: VALID_ROLES });
  const m = registry.models.find(x => x.id === b.id);
  if (!m) return send(res, 404, { error: "unknown model" });
  m.role = b.role;
  send(res, 200, statusSnapshot());
});
route("POST", "/models/upsert", async (req,res) => {
  const b = await readJson(req);
  if (!b.id||!b.backend||!b.target) return send(res, 400, { error: "need { id, backend, target }" });
  if (!backends[b.backend]) return send(res, 400, { error: `unknown backend: ${b.backend}` });
  const ex = registry.models.find(m => m.id === b.id);
  if (ex) Object.assign(ex, { name:b.name??ex.name, target:b.target, backend:b.backend, role:b.role??ex.role });
  else registry.models.push({ id:b.id, name:b.name||b.id, backend:b.backend, target:b.target, role:b.role||"researcher", enabled:b.enabled??true });
  send(res, 200, statusSnapshot());
});
route("POST", "/mode", async (req,res) => {
  const b = await readJson(req);
  if (!VALID_MODES.includes(b.mode)) return send(res, 400, { error: "invalid mode", valid: VALID_MODES });
  registry.mode = b.mode;
  if (b.active_model)           registry.active_model  = b.active_model;
  if ("supervisor_id" in b)     registry.supervisor_id  = b.supervisor_id || null;
  if (Array.isArray(b.multi_members)) registry.multi_members = b.multi_members;
  if (b.debate) {
    if (Array.isArray(b.debate.participants)) registry.debate.participants = b.debate.participants;
    if (typeof b.debate.rounds === "number")  registry.debate.rounds       = b.debate.rounds;
  }
  if (b.autonomous) {
    if (b.autonomous.model)                           registry.autonomous.model          = b.autonomous.model;
    if (typeof b.autonomous.max_iterations === "number") registry.autonomous.max_iterations = b.autonomous.max_iterations;
  }
  send(res, 200, statusSnapshot());
});
route("POST", "/supervisor", async (req,res) => {
  const b = await readJson(req);
  if (!b.id) registry.supervisor_id = null;
  else {
    const m = registry.models.find(x => x.id === b.id);
    if (!m) return send(res, 404, { error: "unknown model" });
    registry.supervisor_id = m.id;
  }
  send(res, 200, statusSnapshot());
});
route("POST", "/tools/toggle", async (req,res) => {
  const b = await readJson(req);
  if (!toolRegistry[b.tool]) return send(res, 404, { error: "unknown tool" });
  toolRegistry[b.tool].enabled = !!b.enabled;
  send(res, 200, statusSnapshot());
});
route("POST", "/session/approve", async (req,res) => {
  if (!_pendingResolve) return send(res, 400, { error: "no pending approval" });
  const b = await readJson(req);
  _pendingResolve(!!b.approved);
  send(res, 200, { approved: !!b.approved });
});
route("POST", "/session/kill", async (req,res) => {
  sess.killed = true;
  if (_pendingResolve) { _pendingResolve(false); _pendingResolve = null; }
  send(res, 200, { killed: true });
});
route("POST", "/chat", async (req,res) => {
  const b = await readJson(req);
  const messages = b.messages ?? (b.message ? [{ role:"user", content:b.message }] : null);
  if (!messages) return send(res, 400, { error: "send { message } or { messages }" });
  if (b.system) messages.unshift({ role:"system", content:b.system });
  const mode = b.mode || registry.mode;
  try {
    let result;
    if (mode === "single")          result = await runSingle(messages, b.model);
    else if (mode === "multi")      result = await runMulti(messages);
    else if (mode === "supervisor") result = await runSupervised(messages);
    else if (mode === "debate")     result = await runDebate(messages);
    else if (mode === "autonomous") result = await runAutonomous(messages[messages.length-1]?.content || "");
    else throw new Error(`unsupported mode: ${mode}`);
    send(res, mode === "autonomous" ? 202 : 200, result);
  } catch (e) {
    send(res, 500, { error: String(e.message || e) });
  }
});

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type, x-relay-key");
  if (req.method === "OPTIONS") return res.end();
  const key = `${req.method} ${req.url.split("?")[0]}`;
  const entry = routes[key];
  if (!entry) return send(res, 404, { error: "not found", route: key });
  if (!entry.opts.public && !auth(req)) return send(res, 401, { error: "unauthorized" });
  try { await entry.handler(req, res); }
  catch (e) { send(res, 500, { error: String(e.message || e) }); }
});

// ---------- startup ----------
await loadSession();
server.listen(PORT, () => {
  console.log(`Stage 6 orchestrator on http://localhost:${PORT}`);
  console.log(`Dashboard: http://localhost:${PORT}/`);
  console.log(`Session:   ${SESSION_FILE}  (id: ${sess.id})`);
  console.log(`Tools: all disabled by default — enable in dashboard`);
});

// ---------- dashboard ----------
const DASHBOARD_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>AI Orchestrator</title>
<style>
  :root{--bg:#0e1116;--panel:#151a22;--line:#222a36;--text:#e6edf3;--muted:#8b95a5;--green:#2ea043;--red:#f85149;--accent:#58a6ff;--warn:#d29922}
  *{box-sizing:border-box}
  body{margin:0;font-family:ui-sans-serif,system-ui,sans-serif;background:var(--bg);color:var(--text)}
  header{padding:14px 20px;border-bottom:1px solid var(--line);display:flex;gap:16px;align-items:center;flex-wrap:wrap}
  header h1{font-size:16px;margin:0;font-weight:600}
  header input{background:var(--panel);border:1px solid var(--line);color:var(--text);padding:6px 10px;border-radius:6px;font-size:13px}
  .banner{padding:12px 20px;font-weight:700;letter-spacing:.04em;text-align:center}
  .banner.green{background:rgba(46,160,67,.15);color:var(--green);border-bottom:2px solid var(--green)}
  .banner.red{background:rgba(248,81,73,.15);color:var(--red);border-bottom:2px solid var(--red);animation:pulse 1.8s ease-in-out infinite}
  .banner.warn{background:rgba(210,153,34,.15);color:var(--warn);border-bottom:2px solid var(--warn);animation:pulse .9s ease-in-out infinite}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.55}}
  main{display:grid;grid-template-columns:1fr 1fr;gap:16px;padding:20px}
  @media(max-width:900px){main{grid-template-columns:1fr}}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px}
  .panel h2{font-size:13px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin:0 0 12px}
  .model{display:grid;grid-template-columns:1fr auto;gap:10px;align-items:center;padding:10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px}
  .model.disabled{opacity:.5}
  .model .name{font-weight:600}
  .model .meta{font-size:12px;color:var(--muted);margin-top:4px;display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .tool-row{display:flex;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px}
  .tool-row label{flex:1;font-size:13px}
  .tool-row small{color:var(--muted);font-size:11px}
  select,button,input[type=number]{background:#1e242e;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font-size:12px;cursor:pointer}
  input[type=number]{width:70px}
  button:hover{border-color:var(--accent)}
  button.primary{background:var(--accent);color:#0b0f14;border-color:var(--accent);font-weight:600}
  button.danger{background:rgba(248,81,73,.2);color:var(--red);border-color:var(--red)}
  button.approve{background:rgba(46,160,67,.2);color:var(--green);border-color:var(--green)}
  button.warn{background:rgba(210,153,34,.2);color:var(--warn);border-color:var(--warn)}
  .row{display:flex;gap:10px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
  .row label{font-size:12px;color:var(--muted);min-width:90px}
  textarea{width:100%;min-height:90px;background:#1e242e;color:var(--text);border:1px solid var(--line);border-radius:6px;padding:10px;font-family:inherit;font-size:13px;resize:vertical}
  pre{background:#0b0f14;border:1px solid var(--line);border-radius:6px;padding:12px;overflow:auto;font-size:12px;max-height:400px;white-space:pre-wrap;word-break:break-word}
  .pill{display:inline-block;padding:2px 8px;background:#1e242e;border:1px solid var(--line);border-radius:999px;font-size:11px;color:var(--muted)}
  .pill.on{color:var(--green);border-color:var(--green)}
  .pill.off{color:var(--red);border-color:var(--red)}
  .pill.sup{color:var(--accent);border-color:var(--accent)}
  details{margin-top:10px;font-size:12px}
  details summary{cursor:pointer;color:var(--muted)}
  #approvalBox{display:none;background:rgba(210,153,34,.1);border:2px solid var(--warn);border-radius:10px;padding:14px;margin-top:12px}
  #approvalBox h3{color:var(--warn);margin:0 0 8px;font-size:14px}
  #sessInfo{font-size:11px;color:var(--muted);margin-top:4px}
</style></head>
<body>
<header>
  <h1>🧠 Multi-Model Orchestrator <span class="pill">Stage 6</span></h1>
  <div style="flex:1"></div>
  <label style="font-size:12px;color:var(--muted)">Relay secret:</label>
  <input id="secret" type="password" placeholder="x-relay-key"/>
</header>

<div id="banner" class="banner red">INDEPENDENT AGENT MODE ACTIVE</div>

<main>
  <div style="display:flex;flex-direction:column;gap:16px">
    <section class="panel">
      <h2>AI Participation Panel</h2>
      <div id="models"></div>
      <div class="row" style="margin-top:14px">
        <label>Mode:</label>
        <select id="mode">
          <option value="single">single</option>
          <option value="multi">multi (fan-out)</option>
          <option value="supervisor">supervisor</option>
          <option value="debate">debate</option>
          <option value="autonomous">autonomous</option>
        </select>
        <button onclick="setMode()">Apply</button>
      </div>
      <div class="row"><label>Active model:</label><select id="activeModel"></select><button onclick="setActive()">Set</button></div>
      <div class="row"><label>Supervisor:</label><select id="supervisor"><option value="">— none —</option></select><button onclick="setSupervisor()">Apply</button></div>
      <div class="row" id="debateRow">
        <label>Debate A:</label><select id="debA"></select>
        <label style="min-width:auto">vs B:</label><select id="debB"></select>
        <label style="min-width:auto">rounds:</label><input id="debRounds" type="number" min="1" max="8" value="2"/>
        <button onclick="setDebate()">Apply</button>
      </div>
      <div class="row" id="autoRow">
        <label>Agent model:</label><select id="autoModel"></select>
        <label style="min-width:auto">max iter:</label><input id="autoIter" type="number" min="1" max="50" value="10"/>
        <button onclick="setAutonomous()">Apply</button>
      </div>
    </section>

    <section class="panel">
      <h2>Tool Registry</h2>
      <div id="tools"></div>
    </section>
  </div>

  <div style="display:flex;flex-direction:column;gap:16px">
    <section class="panel">
      <h2>Chat / Task</h2>
      <textarea id="prompt" placeholder="Ask something or give the agent a task..."></textarea>
      <div class="row" style="margin-top:10px">
        <button class="primary" onclick="sendChat()">Send</button>
        <button class="danger" id="killBtn" onclick="killSession()" style="display:none">⏹ Kill Agent</button>
        <button class="warn" id="resetBtn" onclick="resetSession()">⟳ Reset Session</button>
        <span id="status" style="font-size:12px;color:var(--muted)"></span>
      </div>
      <div id="sessInfo"></div>

      <div id="approvalBox">
        <h3>⚠️ Agent requesting disabled tool</h3>
        <div id="approvalDetail"></div>
        <div class="row" style="margin-top:10px">
          <button class="approve" onclick="decide(true)">✓ Approve (once)</button>
          <button class="danger" onclick="decide(false)">✗ Deny</button>
        </div>
      </div>

      <h2 style="margin-top:16px">Reply</h2>
      <pre id="reply">—</pre>
      <details id="detailsBlock" style="display:none">
        <summary>Show session log / drafts / transcript</summary>
        <pre id="extra"></pre>
      </details>
    </section>

    <section class="panel" id="sessionPanel" style="display:none">
      <h2>Agent Session Log
        <button class="warn" onclick="viewHistory()" style="float:right;font-size:11px;padding:3px 8px">View History</button>
      </h2>
      <pre id="sessionLog" style="max-height:250px"></pre>
    </section>
  </div>
</main>

<script>
const $=sel=>document.querySelector(sel);
const secretInput=$('#secret');
secretInput.value=localStorage.getItem('relay_secret')||'';
secretInput.addEventListener('change',()=>localStorage.setItem('relay_secret',secretInput.value));

function headers(json=false){const h={'x-relay-key':secretInput.value};if(json)h['content-type']='application/json';return h;}
async function api(method,path,body){
  const r=await fetch(path,{method,headers:headers(!!body),body:body?JSON.stringify(body):undefined});
  const text=await r.text();
  if(!r.ok) throw new Error(text);
  return JSON.parse(text);
}

function fillSelect(sel,models,selectedId,allowEmpty){
  sel.innerHTML='';
  if(allowEmpty){const o=document.createElement('option');o.value='';o.textContent='— none —';sel.appendChild(o);}
  for(const m of models){const o=document.createElement('option');o.value=m.id;o.textContent=m.name;if(m.id===selectedId)o.selected=true;sel.appendChild(o);}
}

let currentMode='single';

async function refresh(){
  try{
    const s=await api('GET','/status');
    currentMode=s.mode;
    const orLabel=s.openrouter_configured?'✓ OpenRouter':'✗ OpenRouter unconfigured';
    $('#banner').className='banner '+s.banner.color;
    $('#banner').textContent=s.banner.text+(s.supervisor?' — '+s.supervisor.name:'')+'  ·  mode: '+s.mode+'  ·  '+orLabel;

    const modelsEl=$('#models');modelsEl.innerHTML='';
    for(const m of s.models){
      const isSup=s.supervisor&&s.supervisor.id===m.id;
      const card=document.createElement('div');
      card.className='model'+(m.enabled?'':' disabled');
      card.innerHTML=\`<div>
        <div class="name">\${m.name}
          <span class="pill \${m.enabled?'on':'off'}">\${m.enabled?'enabled':'disabled'}</span>
          \${isSup?'<span class="pill sup">supervisor</span>':''}
          <span class="pill">\${m.backend}</span>
        </div>
        <div class="meta">id:\${m.id} · role:<select data-id="\${m.id}" class="roleSel"></select></div>
      </div>
      <button onclick="toggleModel('\${m.id}',\${!m.enabled})">\${m.enabled?'Disable':'Enable'}</button>\`;
      modelsEl.appendChild(card);
      const rs=card.querySelector('.roleSel');
      for(const r of s.valid_roles){const o=document.createElement('option');o.value=r;o.textContent=r;if(r===m.role)o.selected=true;rs.appendChild(o);}
      rs.addEventListener('change',()=>setRole(m.id,rs.value));
    }

    fillSelect($('#activeModel'),s.models,s.active_model,false);
    fillSelect($('#supervisor'),s.models,s.supervisor?.id||'',true);
    fillSelect($('#debA'),s.models,s.debate.participants[0]||s.models[0]?.id,false);
    fillSelect($('#debB'),s.models,s.debate.participants[1]||s.models[1]?.id,false);
    fillSelect($('#autoModel'),s.models,s.autonomous.model||s.models[0]?.id,false);
    $('#debRounds').value=s.debate.rounds||2;
    $('#autoIter').value=s.autonomous.max_iterations||10;
    $('#mode').value=s.mode;
    $('#debateRow').style.display=s.mode==='debate'?'flex':'none';
    $('#autoRow').style.display=s.mode==='autonomous'?'flex':'none';

    const toolsEl=$('#tools');toolsEl.innerHTML='';
    for(const[name,t] of Object.entries(s.tools)){
      const row=document.createElement('div');row.className='tool-row';
      row.innerHTML=\`<label><strong>\${name}</strong><br><small>\${t.description}</small></label>
        <span class="pill \${t.enabled?'on':'off'}">\${t.enabled?'on':'off'}</span>
        <button onclick="toggleTool('\${name}',\${!t.enabled})">\${t.enabled?'Disable':'Enable'}</button>\`;
      toolsEl.appendChild(row);
    }
  }catch(e){
    $('#banner').className='banner red';
    $('#banner').textContent='Cannot reach orchestrator — check relay secret';
  }
}

async function pollSession(){
  if(currentMode!=='autonomous') return;
  try{
    const s=await api('GET','/session');
    $('#sessInfo').textContent='Session: '+s.id+' · '+s.messageCount+' messages persisted';
    if(s.running||s.log.length){
      $('#sessionPanel').style.display='block';
      $('#killBtn').style.display=s.running?'inline-block':'none';
      $('#sessionLog').textContent=s.log.map(l=>JSON.stringify(l)).join('\n');
    }
    if(s.pending){
      $('#banner').className='banner warn';
      $('#banner').textContent='⚠️ AGENT PAUSED — requesting disabled tool: '+s.pending.toolName;
      $('#approvalBox').style.display='block';
      $('#approvalDetail').textContent='Tool: '+s.pending.toolName+'\nArgs: '+JSON.stringify(s.pending.args,null,2);
    } else {
      $('#approvalBox').style.display='none';
    }
    const done=s.log.find(l=>l.type==='done');
    if(done){
      $('#reply').textContent=done.reply||'(agent finished — see session log)';
      $('#status').textContent='agent done';
      $('#killBtn').style.display='none';
    }
    const err=s.log.find(l=>l.type==='error');
    if(err){ $('#status').textContent='error: '+err.message; }
  }catch(e){}
}

async function viewHistory(){
  try{
    const h=await api('GET','/session/history');
    $('#extra').textContent=JSON.stringify(h.messages,null,2);
    $('#detailsBlock').style.display='block';
    $('#detailsBlock').open=true;
  }catch(e){alert('Failed to load history: '+e);}
}

async function resetSession(){
  if(!confirm('Clear session history? (running agent must be killed first)')) return;
  try{await api('POST','/session/reset',{});$('#sessInfo').textContent='Session reset.';}catch(e){alert(String(e));}
}

async function toggleModel(id,enabled){await api('POST','/models/toggle',{id,enabled});refresh();}
async function setRole(id,role){await api('POST','/models/role',{id,role});refresh();}
async function setActive(){await api('POST','/mode',{mode:$('#mode').value,active_model:$('#activeModel').value});refresh();}
async function setMode(){await api('POST','/mode',{mode:$('#mode').value});refresh();}
async function setSupervisor(){await api('POST','/supervisor',{id:$('#supervisor').value||null});refresh();}
async function setDebate(){await api('POST','/mode',{mode:'debate',debate:{participants:[$('#debA').value,$('#debB').value],rounds:Number($('#debRounds').value)||2}});refresh();}
async function setAutonomous(){await api('POST','/mode',{mode:'autonomous',autonomous:{model:$('#autoModel').value,max_iterations:Number($('#autoIter').value)||10}});refresh();}
async function toggleTool(tool,enabled){await api('POST','/tools/toggle',{tool,enabled});refresh();}
async function killSession(){await api('POST','/session/kill',{});$('#killBtn').style.display='none';$('#status').textContent='killed';}
async function decide(approved){await api('POST','/session/approve',{approved});$('#approvalBox').style.display='none';}

async function sendChat(){
  const msg=$('#prompt').value.trim();
  if(!msg) return;
  $('#status').textContent='thinking...';
  $('#reply').textContent='';
  $('#extra').textContent='';
  $('#detailsBlock').style.display='none';
  try{
    const out=await api('POST','/chat',{message:msg});
    if(out.started){
      $('#status').textContent='agent running (session: '+out.session_id+')...';
      $('#reply').textContent='Agent is running — watch the session log below.';
      $('#killBtn').style.display='inline-block';
      $('#sessionPanel').style.display='block';
    } else {
      $('#reply').textContent=out.reply||'';
      const used=Array.isArray(out.model_used)?out.model_used.join(','):(out.model_used||(out.participants?out.participants.join(' vs '):''));
      $('#status').textContent='mode:'+out.mode+' · '+used;
      const extra=out.drafts||out.per_model||out.transcript;
      if(extra){$('#detailsBlock').style.display='block';$('#extra').textContent=JSON.stringify(extra,null,2);}
    }
  }catch(e){$('#status').textContent='error';$('#reply').textContent=String(e);}
}

refresh();
setInterval(refresh,5000);
setInterval(pollSession,2000);
</script>
</body></html>`;
