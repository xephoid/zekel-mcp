// The web debug client (docs/board-viz.md). One self-contained HTML page,
// served at GET /debug by the http transport (src/server/bootstrap.ts). It is a
// real MCP client of THIS server's /mcp endpoint — initialize handshake, then
// tools/call — never a side-channel into the engines, so everything it can do a
// normal model client can do too. Kept as a TS string export so it ships in
// dist/ with zero build plumbing (the dashboardHtml.ts precedent).
//
// Layout (design guide: docs/design/readme.md): a 380px rail on the left holds
// the turn loop as a four-step stepper — Session → Whose turn → Choose a move →
// Confirm — and the board pane on the right shows the game's live board
// (rendered by its own viz/board.ts glue module, in its own theme), the seat
// tableaux, and the feed. Clicking a board piece prefills the move builder from
// the legal-move list. Light ("Campfire") and dark ("Night table") themes.
//
// The embedded JS deliberately avoids template literals so this file needs no
// backtick escaping. scripts/smoke-web.mjs performs the same JSON-RPC dance
// headlessly and is the protocol lock for what this page does.

export const DEBUG_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zekel debug client</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Bricolage+Grotesque:opsz,wght@12..96,700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  /* ---- tokens (docs/design/tokens) ---- */
  :root {
    --bg: #f7f1e6; --surface: #ffffff; --surface-2: #efe7d8;
    --text: #1c1a17; --text-muted: rgba(28,26,23,.6); --text-faint: rgba(28,26,23,.45);
    --border: rgba(28,26,23,.16); --border-strong: rgba(28,26,23,.28);
    --action: #e0762b; --action-hover: #c9662a; --on-action: #fff; --link: #1f4d3a;
    --brand: #1f4d3a; --on-brand: #f7f1e6; --mark-head: #e0762b;
    --highlight: #1f4d3a; --highlight-bg: #e6efe9; --highlight-bg-2: #dde9e1;
    --tag-bg: #efe7d8; --tag-fg: #4a4438;
    --you-bg: #fbe3d2; --you-fg: #7a3a12; --ai-bg: #dde9e1; --ai-fg: #1f4d3a;
    --danger: #b3261e; --danger-bg: #fbe0dd;
    --shadow-sm: 0 1px 2px rgba(28,26,23,.12);
    --font-display: 'Bricolage Grotesque', system-ui, sans-serif;
    --font-body: 'IBM Plex Sans', system-ui, sans-serif;
    --font-mono: 'IBM Plex Mono', ui-monospace, Menlo, monospace;
    --r-sm: 6px; --r-md: 8px; --r-lg: 12px; --rail: 380px;
    color-scheme: light;
  }
  [data-theme="dark"] {
    --bg: #1a221c; --surface: #232e26; --surface-2: #2e3b31;
    --text: #f3ead9; --text-muted: rgba(243,234,217,.6); --text-faint: rgba(243,234,217,.45);
    --border: rgba(243,234,217,.16); --border-strong: rgba(243,234,217,.3);
    --action: #ff8a3d; --action-hover: #ff9d5c; --on-action: #1a221c; --link: #ff8a3d;
    --brand: #f3ead9; --on-brand: #1a221c; --mark-head: #ff8a3d;
    --highlight: #9bb08a; --highlight-bg: #2a3a2e; --highlight-bg-2: #33463a;
    --tag-bg: #2e3b31; --tag-fg: #cfd8c6;
    --you-bg: #4a2d18; --you-fg: #ffc9a3; --ai-bg: #2a3a2e; --ai-fg: #cfe0c4;
    --danger: #ff7b6b; --danger-bg: #4a2320;
    --shadow-sm: 0 1px 2px rgba(0,0,0,.4);
    color-scheme: dark;
  }
  *, *::before, *::after { box-sizing: border-box; }
  html, body { height: 100%; }
  body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.45 var(--font-body); }
  a { color: var(--link); text-underline-offset: 3px; } a:hover { color: var(--action-hover); }
  button { font: inherit; color: inherit; }
  :focus-visible { outline: 2px solid var(--action); outline-offset: 2px; }
  .mono { font-family: var(--font-mono); }
  [hidden] { display: none !important; }

  /* ---- shell ---- */
  .app { display: grid; grid-template-columns: var(--rail) minmax(0, 1fr); height: 100%; }
  .rail { padding: 22px 22px 18px; display: flex; flex-direction: column; min-height: 0; overflow-y: auto; }
  .pane { background: var(--surface); display: grid; grid-template-rows: auto auto minmax(0, 1fr); min-height: 0; padding: 20px 26px 22px; gap: 12px; }
  @media (max-width: 900px) { .app { grid-template-columns: 1fr; height: auto; } .rail { overflow: visible; } .pane { min-height: 60vh; } }

  /* ---- wordmark: the k is a meeple on its back (head left, legs right) ---- */
  .brand { display: flex; align-items: center; gap: 10px; margin-bottom: 22px; }
  .wordmark { display: inline-flex; align-items: center; gap: 1px; font: 700 24px var(--font-display); letter-spacing: -.02em; color: var(--brand); }
  .meeple { display: inline-block; width: 20px; height: 20px; position: relative; transform: rotate(-90deg); margin: 0 1px; }
  .meeple span { position: absolute; background: var(--brand); }
  .meeple .hd { left: 50%; top: 0; width: 34%; height: 34%; transform: translateX(-50%); border-radius: 50%; background: var(--mark-head); }
  .meeple .sh { left: 0; top: 28%; width: 100%; height: 24%; border-radius: 999px; }
  .meeple .bd { left: 50%; top: 40%; width: 48%; height: 36%; transform: translateX(-50%); border-radius: 3px 3px 1px 1px; }
  .meeple .l1 { left: 14%; bottom: 0; width: 32%; height: 38%; border-radius: 3px; transform: rotate(14deg); transform-origin: top center; }
  .meeple .l2 { right: 14%; bottom: 0; width: 32%; height: 38%; border-radius: 3px; transform: rotate(-14deg); transform-origin: top center; }
  .brand .sub { font-size: 12px; color: var(--text-muted); }
  .conn { width: 9px; height: 9px; border-radius: 50%; background: var(--danger); margin-left: auto; flex: none; }
  .conn.ok { background: var(--highlight); }
  .icon-btn { width: 30px; height: 30px; border-radius: var(--r-md); border: 1px solid var(--border); background: transparent; cursor: pointer; font-size: 13px; display: inline-flex; align-items: center; justify-content: center; }
  .icon-btn:hover { background: var(--surface-2); }

  /* ---- stepper ---- */
  .steps { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: 28px 1fr; column-gap: 14px; }
  .steps li { display: contents; }
  .step-marker { display: flex; flex-direction: column; align-items: center; }
  .step-dot { width: 28px; height: 28px; border-radius: 50%; display: inline-flex; align-items: center; justify-content: center; font: 600 12px var(--font-body); flex: none; }
  .step-line { flex: 1; width: 2px; background: var(--border); margin: 4px 0; }
  .step-body { padding-bottom: 18px; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
  .steps li:last-child .step-body { padding-bottom: 0; }
  .steps li:last-child .step-line { display: none; }
  .step-title { font-weight: 600; }
  li.todo .step-dot { border: 2px solid var(--border-strong); color: var(--text-faint); }
  li.todo .step-title { color: var(--text-faint); }
  li.current .step-dot { background: var(--action); color: var(--on-action); }
  li.done .step-dot { background: var(--highlight); color: var(--on-brand); }
  .help { font-size: 12px; color: var(--text-muted); }

  /* ---- controls ---- */
  .btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; min-height: 36px; padding: 0 14px; border-radius: var(--r-md); border: 1px solid var(--border); background: transparent; cursor: pointer; font: 500 13px var(--font-body); }
  .btn:hover { background: var(--surface-2); }
  .btn.primary { background: var(--action); color: var(--on-action); border-color: transparent; font: 700 14px var(--font-display); }
  .btn.primary:hover { background: var(--action-hover); }
  .btn.ghost { border-color: transparent; color: var(--link); padding: 0 8px; }
  .btn:disabled { opacity: .45; cursor: not-allowed; }
  .btn.sm { min-height: 30px; padding: 0 10px; font-size: 12px; }
  input, select, textarea { min-height: 34px; padding: 4px 12px; border-radius: var(--r-md); border: 1px solid var(--border); background: var(--surface); color: var(--text); font: 13px var(--font-body); }
  .rail input, .rail select { background: var(--surface); }
  textarea { width: 100%; font-family: var(--font-mono); font-size: 12px; }
  label.f { display: flex; flex-direction: column; gap: 5px; font-size: 12px; color: var(--text-muted); }
  .row { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
  .tag { display: inline-flex; align-items: center; font-size: 11px; padding: 3px 9px; border-radius: var(--r-sm); background: var(--tag-bg); color: var(--tag-fg); }
  .tag.ok { background: var(--highlight-bg); color: var(--highlight); }
  .tag.warn { background: var(--you-bg); color: var(--you-fg); }
  .kicker { font-size: 10px; letter-spacing: .1em; text-transform: uppercase; color: var(--action); font-weight: 600; }
  details > summary { cursor: pointer; font-size: 12px; color: var(--text-muted); list-style: none; }
  details > summary::-webkit-details-marker { display: none; }
  details > summary::after { content: ' ▸'; } details[open] > summary::after { content: ' ▾'; }
  details .inner { margin-top: 8px; display: flex; flex-direction: column; gap: 8px; }
  pre { margin: 0; background: var(--surface-2); border-radius: var(--r-lg); padding: 10px 12px; font: 12px/1.4 var(--font-mono); color: var(--tag-fg); overflow: auto; max-height: 40vh; white-space: pre-wrap; }

  /* seats */
  .seat { display: grid; grid-template-columns: 54px minmax(0, 1fr) auto; grid-template-areas: "pid name rm" "kind diff rm"; align-items: center; gap: 4px 6px; padding: 4px 4px 4px 10px; border-radius: var(--r-md); background: var(--surface); border: 1px solid var(--border); }
  .seat .pid { grid-area: pid; width: 100%; font-family: var(--font-mono); font-size: 12px; min-height: 28px; padding: 2px 6px; border: 0; background: transparent; }
  .seat .pname { grid-area: name; width: 100%; min-width: 0; min-height: 28px; padding: 2px 6px; border: 0; background: transparent; }
  .seat .kind { grid-area: kind; } .seat .diff { grid-area: diff; justify-self: start; } .seat .rm { grid-area: rm; }
  .seat select { min-height: 28px; padding: 2px 6px; font-size: 12px; }
  .seat .rm { width: 24px; height: 24px; border-radius: 50%; border: 0; background: transparent; color: var(--text-faint); cursor: pointer; }
  .seat .rm:hover { background: var(--surface-2); }

  /* move menu */
  .crumbs { display: flex; gap: 6px; flex-wrap: wrap; align-items: center; font-size: 13px; }
  .crumb { padding: 4px 12px; border-radius: var(--r-md); background: var(--you-bg); color: var(--you-fg); font-weight: 600; }
  .crumb.last { background: var(--action); color: var(--on-action); }
  .crumb-sep { color: var(--text-faint); }
  .crumb-back { width: 26px; height: 26px; border-radius: 50%; border: 1px solid var(--border); background: transparent; cursor: pointer; }
  .pending { padding: 4px 12px; border-radius: var(--r-md); border: 1.5px dashed var(--highlight); color: var(--highlight); }
  #menu { display: flex; flex-direction: column; gap: 5px; }
  .menu-row { display: flex; align-items: center; gap: 10px; width: 100%; text-align: left; padding: 8px 12px; border-radius: var(--r-md); border: 1px solid var(--border); background: transparent; cursor: pointer; }
  .menu-row:hover { background: var(--highlight-bg-2); }
  .menu-row.selected { border-color: var(--highlight); background: var(--highlight-bg); }
  .menu-row .key { width: 26px; height: 26px; border-radius: 50%; background: var(--text); color: var(--bg); font: 600 12px var(--font-body); display: inline-flex; align-items: center; justify-content: center; flex: none; }
  .menu-row .lbl { flex: 1; font-weight: 600; min-width: 0; }
  .menu-row .hint { font-size: 11px; color: var(--text-muted); }
  .grey-row { display: flex; gap: 10px; padding: 6px 12px; border-radius: var(--r-md); border: 1px dashed var(--border); color: var(--text-muted); font-size: 12px; margin-top: 4px; }
  .grey-row .what { font-weight: 600; text-decoration: line-through; flex: none; }
  .grey-row .why { flex: 1; min-width: 0; }
  #moveForm { display: flex; flex-direction: column; gap: 6px; }
  #moveForm .row label { font-size: 12px; color: var(--text-muted); min-width: 72px; }
  #moveForm .row input, #moveForm .row select { min-height: 30px; font-size: 12px; }
  #moveForm > div > div { margin-left: 0 !important; display: flex; flex-direction: column; gap: 6px; }
  .rail-foot { margin-top: auto; padding-top: 18px; display: flex; flex-direction: column; gap: 10px; }

  /* ---- pane ---- */
  .pane-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .pane-head h2 { margin: 0; font: 700 22px var(--font-display); letter-spacing: -.02em; }
  .pane-head .status { font-size: 12px; color: var(--text-muted); }
  .pane-head .right { margin-left: auto; display: flex; gap: 8px; align-items: center; font-size: 12px; color: var(--text-muted); }
  #error { color: var(--danger); background: var(--danger-bg); border-radius: var(--r-md); padding: 8px 12px; font-size: 13px; white-space: pre-wrap; }
  #error:empty { display: none; }
  .scroll { overflow-y: auto; min-height: 0; display: flex; flex-direction: column; gap: 14px; }
  #board { background: var(--bg); border-radius: var(--r-lg); padding: 14px; }
  #ascii { font-family: var(--font-mono); white-space: pre; font-size: 12px; max-height: none; }
  .zone-h { font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: var(--text-muted); margin-bottom: 6px; }
  #feed { display: flex; flex-direction: column; gap: 6px; }
  #feed div { font-size: 12px; padding: 8px 12px; border-radius: var(--r-lg); background: var(--bg); box-shadow: var(--shadow-sm); }
  #feed div b { font-weight: 600; margin-right: 4px; }
  #feed div.you b { color: var(--you-fg); } #feed div.ai b { color: var(--ai-fg); }
  #empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px; text-align: center; flex: 1; color: var(--text-muted); padding: 40px 0; }
  #empty .blob { width: 160px; height: 160px; border-radius: 46% 54% 52% 48% / 55% 47% 53% 45%; background: var(--bg); box-shadow: inset 0 0 18px rgba(0,0,0,.06); }
  #empty h3 { margin: 0; font: 700 22px var(--font-display); color: var(--text); letter-spacing: -.02em; }
  #empty p { margin: 0; font-size: 13px; max-width: 380px; }
</style>
</head>
<body>
<div class="app">
<aside class="rail">
  <div class="brand">
    <span class="wordmark">ze<span class="meeple"><span class="hd"></span><span class="sh"></span><span class="bd"></span><span class="l1"></span><span class="l2"></span></span>el</span>
    <span class="sub" id="brandSub">debug client</span>
    <span class="conn" id="connDot" title="not connected"></span>
    <button class="icon-btn" id="themeBtn" title="toggle light / dark">◐</button>
  </div>
  <small id="conn" hidden>(not connected)</small>

  <ol class="steps">
    <li id="step1" class="current">
      <div class="step-marker"><span class="step-dot">1</span><span class="step-line"></span></div>
      <div class="step-body">
        <div class="step-title">Session</div>
        <div id="sessionSummary" class="help" hidden></div>
        <div id="setupBox" style="display:flex;flex-direction:column;gap:10px">
          <label class="f">Game<select id="gameSel"></select></label>
          <div style="display:flex;flex-direction:column;gap:6px">
            <span class="help">Seats</span>
            <div id="seats" style="display:flex;flex-direction:column;gap:6px"></div>
            <button class="btn ghost sm" id="addSeat" style="align-self:flex-start">+ add seat</button>
          </div>
          <label class="f">Options (JSON)<input id="optionsJson" class="mono" placeholder='{"seed":1}'></label>
          <button class="btn primary" id="createBtn" style="align-self:flex-start">Create session</button>
          <details><summary>or attach an existing session_id</summary>
            <div class="inner"><div class="row"><input id="sessionId" class="mono" placeholder="session_id" style="flex:1"><button class="btn" id="attachBtn">Attach</button></div></div>
          </details>
          <details><summary>agent_guidance / setup checklist</summary><div class="inner"><pre id="guidance"></pre></div></details>
        </div>
      </div>
    </li>
    <li id="step2" class="todo">
      <div class="step-marker"><span class="step-dot">2</span><span class="step-line"></span></div>
      <div class="step-body">
        <div class="step-title">Whose turn</div>
        <div id="nextstep" class="help">Create or attach a session to begin.</div>
      </div>
    </li>
    <li id="step3" class="todo">
      <div class="step-marker"><span class="step-dot">3</span><span class="step-line"></span></div>
      <div class="step-body">
        <div class="step-title">Choose a move</div>
        <div id="menuPrompt" class="help"></div>
        <div id="crumbs" class="crumbs" hidden></div>
        <div id="menu"></div>
        <div id="greys"></div>
        <div id="boardHint" class="help" hidden>Press a key, or click a piece on the board to prefill.</div>
        <details id="builderBox"><summary>move builder (forms, no JSON)</summary>
          <div class="inner">
            <select id="lmSel"><option value="">— pick a legal move to prefill —</option></select>
            <select id="typeSel"><option value="">— or start from a move type —</option></select>
            <div id="moveForm"></div>
          </div>
        </details>
      </div>
    </li>
    <li id="step4" class="todo">
      <div class="step-marker"><span class="step-dot">4</span><span class="step-line"></span></div>
      <div class="step-body">
        <div class="step-title">Confirm</div>
        <div id="confirmHelp" class="help">Menu moves apply immediately. Built moves preview here first.</div>
        <pre id="formPreview" hidden></pre>
        <button class="btn primary" id="formApplyBtn" hidden style="align-self:flex-start">Apply this move</button>
        <details><summary>raw JSON (last resort)</summary>
          <div class="inner"><textarea id="moveJson" rows="3" placeholder='{"type":"..."}'></textarea><button class="btn" id="moveBtn" style="align-self:flex-start">apply_move</button></div>
        </details>
      </div>
    </li>
  </ol>

  <div class="rail-foot">
    <div class="row">
      <button class="btn" id="undoBtn">Undo</button>
      <button class="btn" id="aiBtn">Run AI turn</button>
      <button class="btn ghost" id="refreshBtn">Refresh</button>
    </div>
    <div class="row">
      <input id="token" placeholder="bearer token (if set)" style="flex:1;min-height:30px;font-size:12px">
      <button class="btn sm" id="connectBtn">Reconnect</button>
    </div>
  </div>
</aside>

<main class="pane">
  <div class="pane-head">
    <h2 id="paneTitle">zekel debug client</h2>
    <span class="status" id="paneStatus"></span>
    <div class="right">Viewing as <select id="viewerSel"></select></div>
  </div>
  <div id="error"></div>
  <div class="scroll" id="scroll">
    <div id="empty">
      <div class="blob"></div>
      <h3>The table is empty.</h3>
      <p>Create or attach a session and the live board renders here after every move. Games without a board module show their player view instead.</p>
    </div>
    <div id="board" hidden></div>
    <pre id="ascii" hidden></pre>
    <div id="feedBox" hidden><div class="zone-h">Moves &amp; reports</div><div id="feed"></div></div>
    <details id="stateBox" hidden><summary>full player view (JSON)</summary><div class="inner"><pre id="stateJson"></pre></div></details>
    <details id="logBox" hidden><summary>log</summary><div class="inner"><pre id="logJson"></pre></div></details>
  </div>
</main>
</div>

<script>
'use strict';
// A human owes the next move: 'human_to_move', or 'awaiting_private_input'
// (a human turn whose answer the other humans must not hear).
function isHumanStatus(s) { return s === 'human_to_move' || s === 'awaiting_private_input'; }
var sid = null, rpcId = 0, sessionId = null, games = [], menuStack = [], lastNextStep = null, currentMenu = null;

function $(id) { return document.getElementById(id); }
function setError(e) { $('error').textContent = e ? String(e) : ''; }

// ---------- theme ----------
(function initTheme() {
  var saved = null;
  try { saved = localStorage.getItem('zekel-theme'); } catch (e) { /* private mode */ }
  var dark = saved ? saved === 'dark' : window.matchMedia('(prefers-color-scheme: dark)').matches;
  if (dark) document.documentElement.setAttribute('data-theme', 'dark');
})();
$('themeBtn').onclick = function () {
  var isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', 'dark');
  try { localStorage.setItem('zekel-theme', isDark ? 'light' : 'dark'); } catch (e) { /* ignore */ }
};

// ---------- MCP client ----------
async function rpc(method, params, isNotification) {
  var headers = { 'content-type': 'application/json',
                  'accept': 'application/json, text/event-stream' };
  if (sid) headers['mcp-session-id'] = sid;
  var token = $('token').value.trim();
  if (token) headers['authorization'] = 'Bearer ' + token;
  var body = { jsonrpc: '2.0', method: method };
  if (params !== undefined) body.params = params;
  var myId = null;
  if (!isNotification) { myId = ++rpcId; body.id = myId; }
  var res = await fetch('/mcp', { method: 'POST', headers: headers, body: JSON.stringify(body) });
  var newSid = res.headers.get('mcp-session-id');
  if (newSid) sid = newSid;
  if (isNotification) return null;
  if (res.status === 401) throw new Error('Unauthorized - set the bearer token');
  var ct = res.headers.get('content-type') || '';
  var msg = null;
  if (ct.indexOf('text/event-stream') >= 0) {
    var text = await res.text();
    var events = text.split('\\n\\n');
    for (var i = 0; i < events.length; i++) {
      var data = events[i].split('\\n').filter(function (l) { return l.indexOf('data:') === 0; })
        .map(function (l) { return l.slice(5).trim(); }).join('');
      if (!data) continue;
      var parsed = JSON.parse(data);
      if (parsed.id === myId) msg = parsed;
    }
  } else {
    msg = await res.json();
  }
  if (!msg) throw new Error('no response for ' + method);
  if (msg.error) throw new Error(msg.error.message || JSON.stringify(msg.error));
  return msg.result;
}

// Call an MCP tool; every zekel tool returns ok()/fail() with a JSON text body.
async function tool(name, args) {
  var result = await rpc('tools/call', { name: name, arguments: args || {} });
  var text = (result.content && result.content[0] && result.content[0].text) || '';
  var payload;
  try { payload = JSON.parse(text); } catch (e) { payload = text; }
  if (result.isError) {
    var m = payload && payload.message ? payload.error_code + ': ' + payload.message : text;
    throw new Error(m);
  }
  return payload;
}

async function connect() {
  setError('');
  sid = null;
  await rpc('initialize', {
    protocolVersion: '2025-03-26',
    capabilities: {},
    clientInfo: { name: 'zekel-debug-client', version: '0.2' },
  });
  await rpc('notifications/initialized', {}, true);
  var res = await tool('list_games', {});
  games = res.games || res;
  var sel = $('gameSel');
  sel.innerHTML = '';
  games.forEach(function (g) {
    var o = document.createElement('option');
    o.value = g.game_id || g.id;
    o.textContent = (g.name || g.game_id || g.id) + ' (' + (g.min_players || '?') + '-' + (g.max_players || '?') + 'p)';
    sel.appendChild(o);
  });
  $('conn').textContent = '(connected - ' + games.length + ' games)';
  $('connDot').className = 'conn ok';
  $('connDot').title = 'connected - ' + games.length + ' games';
}

function gameName(gid) {
  for (var i = 0; i < games.length; i++) {
    var g = games[i];
    if ((g.game_id || g.id) === gid) return g.name || gid;
  }
  return gid;
}

// ---------- seats ----------
function seatRow(pid, kind, name, difficulty) {
  var d = document.createElement('div');
  d.className = 'seat';
  d.innerHTML =
    '<input class="pid" value="' + pid + '" title="player_id">' +
    '<input class="pname" placeholder="name" value="' + (name || '') + '">' +
    '<select class="kind"><option>human</option><option>ai</option></select>' +
    '<select class="diff" title="AI difficulty"><option value="">default</option><option>random</option><option>easy</option><option>medium</option><option>hard</option><option>mcts</option></select>' +
    '<button class="rm" title="remove seat">×</button>';
  d.querySelector('.kind').value = kind;
  if (difficulty) d.querySelector('.diff').value = difficulty;
  var syncDiff = function () { d.querySelector('.diff').hidden = d.querySelector('.kind').value !== 'ai'; };
  d.querySelector('.kind').onchange = syncDiff;
  syncDiff();
  d.querySelector('.rm').onclick = function () { d.remove(); };
  $('seats').appendChild(d);
}

function readSeats() {
  return Array.prototype.map.call(document.querySelectorAll('.seat'), function (d) {
    var p = { player_id: d.querySelector('.pid').value, kind: d.querySelector('.kind').value };
    var name = d.querySelector('.pname').value.trim();
    var diff = d.querySelector('.diff').value;
    if (name) p.name = name;
    if (diff && p.kind === 'ai') p.difficulty = diff;
    return p;
  });
}

function humanSeats() { return readSeats().filter(function (p) { return p.kind === 'human'; }); }

// ---------- session ----------
async function createSession() {
  setError('');
  var options;
  var raw = $('optionsJson').value.trim();
  if (raw) options = JSON.parse(raw);
  var res = await tool('create_session', {
    game_id: $('gameSel').value,
    players: readSeats(),
    options: options,
  });
  sessionId = res.session_id;
  currentGameId = $('gameSel').value;
  $('sessionId').value = sessionId;
  $('guidance').textContent = JSON.stringify({
    players_recorded: res.players_recorded,
    setup_checklist: res.setup_checklist,
    naming_reminder: res.naming_reminder,
    difficulty_reminder: res.difficulty_reminder,
    join: res.join,
    agent_guidance: res.agent_guidance,
  }, null, 2);
  fillViewer();
  onSessionStart();
  render(res);
  await loadMoveSchema($('gameSel').value);
  await refresh();
}

// Step 1 collapses to a one-line summary once a session exists; "edit" reopens it.
function onSessionStart() {
  var seats = readSeats().map(function (p) {
    return (p.name ? p.name + ' (' + p.player_id + ')' : p.player_id) + (p.kind === 'ai' ? ' · ai' + (p.difficulty ? ' ' + p.difficulty : '') : '');
  });
  var s = $('sessionSummary');
  s.innerHTML = '';
  s.appendChild(document.createTextNode(sessionId + ' · ' + gameName(currentGameId) + ' · ' + seats.join(', ') + ' '));
  var edit = document.createElement('a');
  edit.href = '#'; edit.textContent = 'edit';
  edit.onclick = function (ev) { ev.preventDefault(); $('setupBox').hidden = !$('setupBox').hidden; };
  s.appendChild(edit);
  s.hidden = false;
  $('setupBox').hidden = true;
  $('paneTitle').textContent = gameName(currentGameId);
  $('brandSub').textContent = 'debug · ' + gameName(currentGameId);
  $('empty').hidden = true;
  $('feedBox').hidden = false;
  $('stateBox').hidden = false;
  $('logBox').hidden = false;
  $('feed').innerHTML = '';
  setSteps();
}

function fillViewer() {
  var sel = $('viewerSel');
  sel.innerHTML = '';
  readSeats().forEach(function (p) {
    var o = document.createElement('option');
    o.value = p.player_id;
    o.textContent = p.player_id + (p.name ? ' · ' + p.name : '') + ' (' + p.kind + ')';
    sel.appendChild(o);
  });
  var h = humanSeats();
  if (h.length) sel.value = h[0].player_id;
}

async function refresh() {
  if (!sessionId) return;
  setError('');
  var viewer = $('viewerSel').value || (humanSeats()[0] || readSeats()[0]).player_id;
  var res = await tool('get_state', { session_id: sessionId, player_id: viewer });
  render(res);
  await refreshBoard(res);
  await loadLegalMoves();
  setSteps();
}

// Feed entries: WHO in bold, then the clause. Newest first.
function feed(who, text) {
  var d = document.createElement('div');
  var kind = who === 'YOU' ? 'you' : who.indexOf('AI') === 0 ? 'ai' : 'sys';
  d.className = kind;
  var b = document.createElement('b');
  b.textContent = who;
  d.appendChild(b);
  d.appendChild(document.createTextNode(text));
  $('feed').prepend(d);
  while ($('feed').children.length > 60) $('feed').lastChild.remove();
}

// ---------- stepper state ----------
function setSteps() {
  var s1 = $('step1'), s2 = $('step2'), s3 = $('step3'), s4 = $('step4');
    var human = !!(lastNextStep && isHumanStatus(lastNextStep.status));
  var over = !!(lastNextStep && (lastNextStep.status === 'game_over' || lastNextStep.status === 'finished'));
  if (!sessionId) {
    s1.className = 'current'; s2.className = 'todo'; s3.className = 'todo'; s4.className = 'todo';
    return;
  }
  s1.className = 'done';
  s2.className = human || over ? 'done' : 'current';
  s3.className = human ? (currentForm ? 'done' : 'current') : 'todo';
  s4.className = human && currentForm ? 'current' : 'todo';
  $('boardHint').hidden = !human;
}

// ---------- board host (docs/board-viz.md) ----------
// If the game ships a glue module (src/games/<id>/viz/board.ts, served at
// /web/games/<id>/viz/board.js), render the live board with the zekel-*
// component library. The library is loaded up front so glue modules never
// import browser paths themselves (host contract, src/web/host.ts).
var boardModules = {};   // game_id -> module | null (null = tried, none)
var currentGameId = null;
var libraryLoaded = null;

function loadLibrary() {
  if (!libraryLoaded) libraryLoaded = import('/web/components/index.js');
  return libraryLoaded;
}

async function refreshBoard(view) {
  var box = $('board');
  var gid = currentGameId || $('gameSel').value;
  if (!gid) { box.hidden = true; return; }
  if (!(gid in boardModules)) {
    try {
      await loadLibrary();
      boardModules[gid] = await import('/web/games/' + gid + '/viz/board.js');
    } catch (e) { boardModules[gid] = null; }
  }
  var mod = boardModules[gid];
  if (!mod || !mod.renderBoard) { box.hidden = true; return; }
  try {
    mod.renderBoard(view, box, $('viewerSel').value);
    box.hidden = false;
  } catch (e) {
    box.hidden = true;
    setError('board render failed: ' + e);
  }
}

// Clicking a board piece prefills the move builder: legal moves whose JSON
// mentions the clicked thing (its id, label, or coordinates) are the candidates.
// One candidate → the form opens prefilled; several → the legal-move picker is
// narrowed to them; none → just logged.
document.addEventListener('zekel-select', function (ev) {
  var d = ev.detail || {};
  feed('BOARD', ' ' + JSON.stringify(d));
  if (!legalMovesCache.length) return;
  var needles = [];
  Object.keys(d).forEach(function (k) {
    if (k === 'component' || k === 'kind') return;
    var v = d[k];
    if (v === null || v === undefined || v === '') return;
    needles.push(JSON.stringify(v));
  });
  if (d.x !== undefined && d.y !== undefined) {
    // grid-cell clicks: accept either coordinate frame the games use
    needles.push('"x":' + d.x + ',"y":' + d.y);
    needles.push('"col":' + d.x + ',"row":' + d.y);
    needles.push('"row":' + d.y + ',"col":' + d.x);
  }
  if (!needles.length) return;
  var matches = [];
  legalMovesCache.forEach(function (lm, i) {
    var s = JSON.stringify(lm.move) + ' ' + (lm.description || '');
    for (var n = 0; n < needles.length; n++) {
      if (s.indexOf(needles[n]) >= 0) { matches.push(i); return; }
    }
  });
  if (!matches.length) return;
  $('builderBox').open = true;
  if (matches.length === 1) {
    $('lmSel').value = String(matches[0]);
    $('lmSel').onchange();
    return;
  }
  fillLegalMoveSelect(matches);
  $('menuPrompt').textContent = matches.length + ' legal moves involve that piece — pick one below.';
});

// ---------- move builder: schema/skeleton-driven forms ----------
// The server publishes each move type's JSON schema (get_rules.move_schema,
// oneOf variants keyed by a type/action const) and each legal move as a full
// object (get_legal_moves[].move). Forms are generated from both: pick a legal
// move to prefill, or a bare type to fill from scratch — no hand-written JSON.
var moveSchemaByType = {}; // discriminant value -> { key: 'type'|'action', schema }
var legalMovesCache = [];
var currentForm = null;    // { get: () => move }

async function loadMoveSchema(gameId) {
  moveSchemaByType = {};
  try {
    var res = await tool('get_rules', { game_id: gameId });
    var variants = (res.move_schema && (res.move_schema.oneOf || res.move_schema.anyOf)) || [];
    variants.forEach(function (v) {
      var props = v.properties || {};
      var key = props.type && props.type.const !== undefined ? 'type' : props.action && props.action.const !== undefined ? 'action' : null;
      if (key) moveSchemaByType[props[key].const] = { key: key, schema: v };
    });
  } catch (e) { /* schemaless games still get skeleton-driven forms */ }
  var sel = $('typeSel');
  sel.innerHTML = '<option value="">— or start from a move type —</option>';
  Object.keys(moveSchemaByType).sort().forEach(function (t) {
    var o = document.createElement('option');
    o.value = t; o.textContent = t;
    sel.appendChild(o);
  });
}

function fillLegalMoveSelect(onlyIdx) {
  var sel = $('lmSel');
  sel.innerHTML = '<option value="">— pick a legal move to prefill —</option>';
  legalMovesCache.forEach(function (lm, i) {
    if (onlyIdx && onlyIdx.indexOf(i) < 0) return;
    var o = document.createElement('option');
    o.value = String(i);
    o.textContent = (lm.description || JSON.stringify(lm.move)).slice(0, 110);
    sel.appendChild(o);
  });
}

// The greyed-out moves (rules teaching): what can't be done right now, and why,
// in the game's own words — shown beside the menu, never clickable.
function renderGreys(greys) {
  var box = $('greys');
  if (!box) return;
  box.innerHTML = '';
  greys.forEach(function (g) {
    var row = document.createElement('div');
    row.className = 'grey-row';
    row.innerHTML = '<span class="what"></span><span class="why"></span>';
    row.querySelector('.what').textContent = g.item ? g.item : g.move_type.replace(/_/g, ' ');
    row.querySelector('.why').textContent = g.reason;
    box.appendChild(row);
  });
}

async function loadLegalMoves() {
  legalMovesCache = [];
  fillLegalMoveSelect();
  renderGreys([]);
  if (!sessionId || !lastNextStep || !isHumanStatus(lastNextStep.status)) return;
  try {
    var res = await tool('get_legal_moves', { session_id: sessionId, player_id: lastNextStep.active_player_id });
    legalMovesCache = res.legal_moves || [];
    fillLegalMoveSelect();
    renderGreys(res.unavailable_moves || []);
  } catch (e) { /* off-turn etc. */ }
}

// Build one field editor; returns { el, get } (get() -> current value).
function fieldEditor(name, fs, value) {
  fs = fs || {};
  var wrap = document.createElement('div');
  wrap.className = 'row';
  var label = document.createElement('label');
  label.textContent = name;
  label.title = fs.description || '';
  wrap.appendChild(label);
  function simple(el, get) { wrap.appendChild(el); return { el: wrap, get: get }; }

  if (fs.const !== undefined) {
    var fixed = document.createElement('b');
    fixed.textContent = String(fs.const);
    return simple(fixed, function () { return fs.const; });
  }
  if (fs.enum) {
    var sel = document.createElement('select');
    fs.enum.forEach(function (v) {
      var o = document.createElement('option');
      o.value = JSON.stringify(v); o.textContent = String(v);
      sel.appendChild(o);
    });
    if (value !== undefined) sel.value = JSON.stringify(value);
    return simple(sel, function () { return JSON.parse(sel.value); });
  }
  var t = fs.type || (Array.isArray(value) ? 'array' : typeof value === 'object' && value !== null ? 'object' : typeof value === 'number' ? 'number' : typeof value === 'boolean' ? 'boolean' : 'string');
  if (t === 'boolean') {
    var cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!value;
    return simple(cb, function () { return cb.checked; });
  }
  if (t === 'integer' || t === 'number') {
    var num = document.createElement('input');
    num.type = 'number';
    if (fs.minimum !== undefined) num.min = fs.minimum;
    if (fs.maximum !== undefined) num.max = fs.maximum;
    if (t === 'number') num.step = 'any';
    if (value !== undefined) num.value = String(value);
    else if (fs.minimum !== undefined) num.value = String(fs.minimum);
    return simple(num, function () { return num.value === '' ? undefined : Number(num.value); });
  }
  if (t === 'array') {
    var box = document.createElement('div');
    var rows = [];
    function addRow(v) {
      var itemSchema = fs.items || {};
      var rowEd = itemSchema.type === 'object' || (v && typeof v === 'object' && !Array.isArray(v))
        ? objectEditor(itemSchema, v || {})
        : fieldEditor('item', itemSchema, v);
      var line = document.createElement('div');
      line.className = 'row';
      var rm = document.createElement('button');
      rm.className = 'btn sm';
      rm.textContent = '−';
      rm.onclick = function (ev) { ev.preventDefault(); rows.splice(rows.indexOf(rowEd), 1); line.remove(); };
      line.appendChild(rowEd.el);
      line.appendChild(rm);
      box.appendChild(line);
      rows.push(rowEd);
    }
    (Array.isArray(value) ? value : []).forEach(addRow);
    var add = document.createElement('button');
    add.className = 'btn sm';
    add.textContent = '+ ' + name;
    add.onclick = function (ev) { ev.preventDefault(); addRow(undefined); };
    wrap.appendChild(box);
    wrap.appendChild(add);
    return { el: wrap, get: function () { return rows.map(function (r) { return r.get(); }); } };
  }
  if (t === 'object') {
    var objEd = objectEditor(fs, value || {});
    wrap.appendChild(objEd.el);
    return { el: wrap, get: objEd.get };
  }
  var txt = document.createElement('input');
  txt.size = 18;
  if (value !== undefined) txt.value = typeof value === 'string' ? value : JSON.stringify(value);
  return simple(txt, function () {
    if (txt.value === '') return undefined;
    try { return JSON.parse(txt.value); } catch (e) { return txt.value; }
  });
}

// Editor for an object: schema properties first, then any extra keys the
// prefill value carries that the schema missed (schemaless games run on this).
function objectEditor(schema, value) {
  var props = (schema && schema.properties) || {};
  var box = document.createElement('div');
  box.style.marginLeft = '10px';
  var eds = {};
  Object.keys(props).forEach(function (k) {
    eds[k] = fieldEditor(k, props[k], value[k]);
    box.appendChild(eds[k].el);
  });
  Object.keys(value).forEach(function (k) {
    if (eds[k]) return;
    eds[k] = fieldEditor(k, undefined, value[k]);
    box.appendChild(eds[k].el);
  });
  return {
    el: box,
    get: function () {
      var out = {};
      Object.keys(eds).forEach(function (k) {
        var v = eds[k].get();
        if (v !== undefined) out[k] = v;
      });
      return out;
    },
  };
}

function showMoveForm(schemaEntry, prefill) {
  var schema = schemaEntry ? schemaEntry.schema : undefined;
  var ed = objectEditor(schema, prefill || {});
  currentForm = ed;
  var host = $('moveForm');
  host.innerHTML = '';
  host.appendChild(ed.el);
  $('builderBox').open = true;
  $('formApplyBtn').hidden = false;
  $('formPreview').hidden = false;
  $('confirmHelp').hidden = true;
  updatePreview();
  host.oninput = updatePreview;
  host.onchange = updatePreview;
  setSteps();
}

function clearMoveForm() {
  $('moveForm').innerHTML = '';
  $('formApplyBtn').hidden = true;
  $('formPreview').hidden = true;
  $('formPreview').textContent = '';
  $('confirmHelp').hidden = false;
  currentForm = null;
}

function updatePreview() {
  if (!currentForm) return;
  try {
    var move = currentForm.get();
    $('formPreview').textContent = JSON.stringify(move, null, 1);
    var disc = move.type !== undefined ? move.type : move.action;
    $('formApplyBtn').textContent = 'Apply' + (disc !== undefined ? ' ' + String(disc) : ' this move');
  } catch (e) { /* mid-edit */ }
}

async function applyFormMove() {
  if (!currentForm) return;
  setError('');
  try {
    var move = currentForm.get();
    var res = await tool('apply_move', {
      session_id: sessionId,
      player_id: moverSeat(),
      move: move,
    });
    feed('YOU', ' ' + (res.state_summary || JSON.stringify(move)));
    clearMoveForm();
    render(res);
    await refresh();
  } catch (e) { setError(e); }
}

// ---------- rendering ----------
function render(res) {
  if (res.next_step) {
    lastNextStep = res.next_step;
    var n = res.next_step;
    var who = n.active_player_id || '-';
    var statusLabel = isHumanStatus(n.status) ? (n.status === 'awaiting_private_input' ? 'Your move (private)' : 'Your move') : n.status === 'ai_to_move' ? 'AI to move' : n.status.replace(/_/g, ' ');
    $('nextstep').innerHTML = '';
    var k = document.createElement('div');
    k.className = 'kicker';
    k.textContent = statusLabel + ' · ' + who;
    $('nextstep').appendChild(k);
    $('nextstep').appendChild(document.createTextNode(n.instruction || ''));
    $('paneStatus').textContent = '[' + n.status + '] active: ' + who;
  }
  if (res.rules_briefing) feed('RULES', ' ' + JSON.stringify(res.rules_briefing).slice(0, 400));
  var ascii = res.ascii || (res.board && res.board.ascii) ||
    (res.ruin && res.ruin.board_rows ? res.ruin.board_rows.join('\\n') : null) ||
    (res.board_rows ? res.board_rows.join('\\n') : null);
  $('ascii').hidden = !ascii;
  if (ascii) $('ascii').textContent = ascii;
  $('stateJson').textContent = JSON.stringify(res, null, 2);
  if (res.log) $('logJson').textContent = JSON.stringify(res.log, null, 2);
  menuStack = [];
  currentMenu = res.move_menu || null;
  renderMenu(currentMenu);
  setSteps();
}

// The move_menu renders as hotkey rows; descending into a submenu pushes a
// breadcrumb chip, and the "‹" chip (or Escape) pops it.
function renderMenu(menu) {
  var box = $('menu');
  var crumbs = $('crumbs');
  box.innerHTML = '';
  crumbs.innerHTML = '';
  $('menuPrompt').textContent = '';
  if (!menu) {
    crumbs.hidden = true;
    box.innerHTML = '<div class="help">' + (sessionId ? 'No menu — not a human turn, or the game is over.' : '') + '</div>';
    return;
  }
  $('menuPrompt').textContent = menu.prompt || '';
  var entries = menuStack.length ? menuStack[menuStack.length - 1].submenu : menu.entries;
  crumbs.hidden = menuStack.length === 0;
  if (menuStack.length) {
    var back = document.createElement('button');
    back.className = 'crumb-back'; back.textContent = '‹'; back.title = 'back';
    back.onclick = function () { menuStack.pop(); renderMenu(menu); };
    crumbs.appendChild(back);
    menuStack.forEach(function (e, i) {
      var c = document.createElement('span');
      c.className = 'crumb' + (i === menuStack.length - 1 ? ' last' : '');
      c.textContent = e.label;
      crumbs.appendChild(c);
      var sep = document.createElement('span');
      sep.className = 'crumb-sep'; sep.textContent = '›';
      crumbs.appendChild(sep);
    });
    var pend = document.createElement('span');
    pend.className = 'pending'; pend.textContent = 'pick one';
    crumbs.appendChild(pend);
  }
  entries.forEach(function (e) {
    var b = document.createElement('button');
    b.className = 'menu-row';
    b.innerHTML = '<span class="key"></span><span class="lbl"></span><span class="hint"></span>';
    b.querySelector('.key').textContent = e.key;
    b.querySelector('.lbl').textContent = e.label;
    b.querySelector('.hint').textContent = e.submenu ? (e.count ? e.count + ' options ›' : '›') : (e.count ? String(e.count) : '');
    b.onclick = function () {
      if (e.submenu) { menuStack.push(e); renderMenu(menu); }
      else if (e.move_id) applyMoveId(e.move_id, e.label);
    };
    box.appendChild(b);
  });
}

// Hotkeys: the menu entry's key applies/descends it; Escape backs out of a submenu.
document.addEventListener('keydown', function (ev) {
  var tag = (ev.target && ev.target.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  if (!currentMenu) return;
  if (ev.key === 'Escape' && menuStack.length) { menuStack.pop(); renderMenu(currentMenu); return; }
  var entries = menuStack.length ? menuStack[menuStack.length - 1].submenu : currentMenu.entries;
  for (var i = 0; i < entries.length; i++) {
    if (String(entries[i].key) === ev.key) {
      var e = entries[i];
      if (e.submenu) { menuStack.push(e); renderMenu(currentMenu); }
      else if (e.move_id) applyMoveId(e.move_id, e.label);
      return;
    }
  }
});

function moverSeat() {
  // Moves belong to the seat the server says is on the clock; the viewer
  // dropdown only controls whose VIEW we read.
  if (lastNextStep && isHumanStatus(lastNextStep.status) && lastNextStep.active_player_id) {
    return lastNextStep.active_player_id;
  }
  return $('viewerSel').value;
}

async function applyMoveId(moveId, label) {
  setError('');
  try {
    var res = await tool('apply_move', {
      session_id: sessionId,
      player_id: moverSeat(),
      move_id: moveId,
    });
    feed('YOU', ' ' + (res.state_summary || label));
    clearMoveForm();
    render(res);
    await refresh();
  } catch (e) { setError(e); }
}

async function applyMoveJson() {
  setError('');
  try {
    var move = JSON.parse($('moveJson').value);
    var res = await tool('apply_move', {
      session_id: sessionId,
      player_id: moverSeat(),
      move: move,
    });
    feed('YOU', ' ' + (res.state_summary || JSON.stringify(move)));
    render(res);
    await refresh();
  } catch (e) { setError(e); }
}

async function runAiTurn() {
  setError('');
  try {
    // run_ai_turn targets the ACTIVE AI seat; re-derive it from next_step.
    if (!lastNextStep || lastNextStep.status !== 'ai_to_move') await refresh();
    if (!lastNextStep || lastNextStep.status !== 'ai_to_move') {
      setError('next_step says it is not an AI turn (' + (lastNextStep ? lastNextStep.status : 'unknown') + ')');
      return;
    }
    var res = await tool('run_ai_turn', {
      session_id: sessionId,
      player_id: lastNextStep.active_player_id,
    });
    (res.moves || []).forEach(function (m) {
      feed('AI ' + (m.player_id || ''), ' ' + (m.state_summary || JSON.stringify(m)));
    });
    render(res);
    await refresh();
  } catch (e) { setError(e); }
}

async function undo() {
  setError('');
  try {
    var res = await tool('undo', { session_id: sessionId });
    feed('UNDO', ' ' + (res.message || 'ok'));
    clearMoveForm();
    await refresh();
  } catch (e) { setError(e); }
}

// ---------- wiring ----------
$('connectBtn').onclick = function () { connect().catch(setError); };
$('createBtn').onclick = function () { createSession().catch(setError); };
$('attachBtn').onclick = function () {
  sessionId = $('sessionId').value.trim();
  if (!sessionId) return;
  currentGameId = $('gameSel').value;
  fillViewer();
  onSessionStart();
  // Attaching uses the currently-selected game for the move-schema forms.
  loadMoveSchema($('gameSel').value).catch(function () {});
  refresh().catch(setError);
};
$('lmSel').onchange = function () {
  var lm = legalMovesCache[Number($('lmSel').value)];
  if (!lm) return;
  var disc = lm.move && (lm.move.type !== undefined ? lm.move.type : lm.move.action);
  showMoveForm(moveSchemaByType[disc], lm.move);
};
$('typeSel').onchange = function () {
  var t = $('typeSel').value;
  if (!t) return;
  var entry = moveSchemaByType[t];
  var seed = {};
  if (entry) seed[entry.key] = t;
  showMoveForm(entry, seed);
};
$('formApplyBtn').onclick = applyFormMove;
$('addSeat').onclick = function () { seatRow('p' + (document.querySelectorAll('.seat').length + 1), 'ai'); };
$('refreshBtn').onclick = function () { refresh().catch(setError); };
$('viewerSel').onchange = function () { refresh().catch(setError); };
$('aiBtn').onclick = runAiTurn;
$('undoBtn').onclick = undo;
$('moveBtn').onclick = applyMoveJson;

seatRow('p1', 'human', '');
seatRow('p2', 'ai', '');
// Connect on load; the Reconnect button (with a bearer token, if the server wants one) retries.
connect().catch(function (e) { setError(e + ' — set the bearer token and press Reconnect.'); });
</script>
</body>
</html>
`;
