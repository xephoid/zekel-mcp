#!/usr/bin/env tsx
// Integration harness: plays a COMPLETE game as the human, through the real
// LibreChat client, and reports what went wrong. The player is a strong LLM
// with a strategy guide and a watch list; the assistant is whatever LibreChat
// agent the human normally plays with. Output: a JSONL transcript, a summary
// JSON with every FLAG the player raised, and one stderr line per message.
//
// Process: docs/integration-runbook.md. Run --check first to verify plumbing.
//
// Examples:
//   tsx scripts/integration-bot.ts --game=cybernoir-2127 --check
//   tsx scripts/integration-bot.ts --game=cybernoir-2127 --agent-id=agent_abc123
//
// Env: LIBRECHAT_EMAIL, LIBRECHAT_PASSWORD  — the bot's LibreChat account
//      PLAYER_BASE_URL, PLAYER_API_KEY      — OpenAI-compatible player endpoint
//      ZEKEL_MCP_TOKEN                      — bearer for the game server (if set)

import { parseArgs } from 'node:util';
import { mkdirSync, readFileSync, appendFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Load .env from the repo root (KEY=VALUE lines; real env vars win). Kept
// dependency-free — the values never leave process.env.
function loadDotEnv(): void {
  const path = resolve('.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (!m || !m[1]) continue;
    const key = m[1];
    let value = m[2] ?? '';
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv();

const DEFAULT_LIBRECHAT_URL = 'https://libre-zekel.ngrok.app';
const DEFAULT_MCP_URL = 'https://zekel.ngrok.app/mcp';
// The player runs on the Ollama box via its OpenAI-compatible /v1 surface.
const DEFAULT_PLAYER_BASE_URL = 'http://192.168.68.100:11434/v1';
const DEFAULT_PLAYER_MODEL = 'kimi-k2.7-code:cloud';
// LibreChat's uaParser middleware rejects any request whose User-Agent does not
// parse as a browser ("Illegal request" + a NON_BROWSER violation), so every
// call must present a browser UA.
const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
// LibreChat's Constants.NO_PARENT — the parentMessageId of a conversation opener.
const NO_PARENT = '00000000-0000-0000-0000-000000000000';

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseCli(argv: string[]) {
  const { values } = parseArgs({
    args: argv,
    options: {
      game: { type: 'string' },
      // LibreChat side. An agent id targets /api/agents/chat (the normal case —
      // MCP servers attach to agents); --endpoint/--model target /api/ask/<endpoint>.
      'agent-id': { type: 'string' },
      endpoint: { type: 'string', default: 'agents' },
      model: { type: 'string' },
      'librechat-url': { type: 'string', default: process.env.LIBRECHAT_URL ?? DEFAULT_LIBRECHAT_URL },
      // Game-server side (the table lookup for ASK-TABLE).
      'mcp-url': { type: 'string', default: process.env.ZEKEL_MCP_URL ?? DEFAULT_MCP_URL },
      // Player side.
      'player-model': { type: 'string', default: process.env.PLAYER_MODEL ?? DEFAULT_PLAYER_MODEL },
      'player-base-url': { type: 'string', default: process.env.PLAYER_BASE_URL ?? DEFAULT_PLAYER_BASE_URL },
      'player-name': { type: 'string', default: 'Riley' },
      // Which identity (role/faction/character) the player asks for this run.
      // The gate needs one full game per playable identity; the guide's default
      // covers only the first run.
      role: { type: 'string' },
      guide: { type: 'string' },
      // Run shape.
      'max-exchanges': { type: 'string', default: '250' },
      'reply-timeout-s': { type: 'string', default: '900' },
      out: { type: 'string', default: './harness-out' },
      check: { type: 'boolean', default: false },
    },
  });
  if (!values.game) {
    throw new Error(
      'Usage: tsx scripts/integration-bot.ts --game=<id> [--check] [--agent-id=A | --endpoint=E --model=M]',
    );
  }
  return {
    game: values.game,
    agentId: values['agent-id'],
    endpoint: values.endpoint!,
    model: values.model,
    librechatUrl: values['librechat-url']!.replace(/\/$/, ''),
    mcpUrl: values['mcp-url']!,
    playerModel: values['player-model']!,
    playerBaseUrl: values['player-base-url']?.replace(/\/$/, ''),
    playerName: values['player-name']!,
    role: values.role,
    guidePath: values.guide ?? `src/games/${values.game}/STRATEGY-GUIDE.md`,
    maxExchanges: Number(values['max-exchanges']),
    replyTimeoutMs: Number(values['reply-timeout-s']) * 1000,
    outDir: values.out!,
    check: values.check!,
  };
}

type Cli = ReturnType<typeof parseCli>;

function log(line: string): void {
  process.stderr.write(`${line}\n`);
}

function clip(s: string, n = 110): string {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n)}…` : one;
}

// ---------------------------------------------------------------------------
// LibreChat client (JWT login + SSE chat)
// ---------------------------------------------------------------------------

class LibreChatClient {
  private token = '';
  private conversationId: string | null = null;
  private parentMessageId = NO_PARENT;

  constructor(private cli: Cli) {}

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.token}`,
      'User-Agent': BROWSER_UA,
      // ngrok's free tier interposes a browser warning page without this.
      'ngrok-skip-browser-warning': '1',
    };
  }

  async login(): Promise<void> {
    const email = process.env.LIBRECHAT_EMAIL;
    const password = process.env.LIBRECHAT_PASSWORD;
    if (!email || !password) {
      throw new Error('Set LIBRECHAT_EMAIL and LIBRECHAT_PASSWORD (the bot\'s LibreChat account).');
    }
    const res = await fetch(`${this.cli.librechatUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': BROWSER_UA, 'ngrok-skip-browser-warning': '1' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) throw new Error(`LibreChat login failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { token?: string };
    if (!body.token) throw new Error('LibreChat login returned no token — API shape changed?');
    this.token = body.token;
  }

  /** Read-only GET helper (shares the 401 re-login retry). */
  async get(path: string): Promise<unknown> {
    return JSON.parse(await this.fetchText(path, { method: 'GET', headers: this.headers() }));
  }

  /** Send one user message; resolve with the assistant's full reply text.
   *
   *  This build uses LibreChat's resumable streams: the POST returns
   *  {streamId, conversationId, status:"started"} immediately, and the reply
   *  arrives on GET /api/agents/chat/stream/{streamId} as SSE. Older builds
   *  stream SSE on the POST body itself — both shapes are handled. */
  async send(text: string): Promise<string> {
    const usingAgent = Boolean(this.cli.agentId);
    const path = usingAgent ? '/api/agents/chat' : `/api/ask/${this.cli.endpoint}`;
    const payload: Record<string, unknown> = {
      text,
      sender: 'User',
      isCreatedByUser: true,
      messageId: randomUUID(),
      parentMessageId: this.parentMessageId,
      conversationId: this.conversationId,
      error: false,
      isContinued: false,
      isTemporary: false,
      endpoint: usingAgent ? 'agents' : this.cli.endpoint,
      ...(usingAgent ? { agent_id: this.cli.agentId } : {}),
      ...(this.cli.model ? { model: this.cli.model } : {}),
    };

    const body = await this.fetchText(path, {
      method: 'POST',
      headers: { ...this.headers(), Accept: 'text/event-stream' },
      body: JSON.stringify(payload),
    });

    let started: any = null;
    try {
      started = JSON.parse(body);
    } catch {
      // Not JSON → an older build streamed the SSE reply on the POST itself.
    }
    if (started?.streamId) {
      if (typeof started.conversationId === 'string') this.conversationId = started.conversationId;
      try {
        return await this.subscribe(String(started.streamId));
      } catch (e) {
        // The stream can drop mid-generation (observed through ngrok) and the
        // job expires before a resume — but LibreChat persists every message,
        // so recover the reply from the conversation store.
        log(`stream lost (${e instanceof Error ? e.message : e}) — recovering reply from conversation messages`);
        return await this.recoverReply(String(payload.messageId));
      }
    }
    return this.extractReply(body);
  }

  /** Fallback when the SSE stream is lost: poll the stored conversation for
   *  the assistant message answering our user message (by parent id). */
  private async recoverReply(userMessageId: string): Promise<string> {
    if (!this.conversationId) throw new Error('stream lost before a conversation id existed');
    const deadline = Date.now() + this.cli.replyTimeoutMs;
    for (;;) {
      await new Promise((r) => setTimeout(r, 10_000));
      let msgs: any = null;
      try {
        msgs = await this.get(`/api/messages/${this.conversationId}`);
      } catch {
        // transient — keep polling until the deadline
      }
      if (Array.isArray(msgs)) {
        const reply = msgs.find(
          (m: any) => m && m.isCreatedByUser === false && m.parentMessageId === userMessageId,
        );
        if (reply) {
          const contentText = Array.isArray(reply.content)
            ? reply.content
                .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
                .map((p: any) => p.text)
                .join('')
            : '';
          const t = (contentText || (typeof reply.text === 'string' ? reply.text : '')).trim();
          if (t) {
            if (typeof reply.messageId === 'string') this.parentMessageId = reply.messageId;
            return t;
          }
        }
      }
      if (Date.now() > deadline) throw new Error('reply never appeared in the conversation store');
    }
  }

  /** GET the SSE stream for a started generation. If the stream closes without
   *  a final event (connected late / hiccup), retry once with ?resume=true. */
  private async subscribe(streamId: string): Promise<string> {
    const base = `/api/agents/chat/stream/${encodeURIComponent(streamId)}`;
    for (const path of [base, `${base}?resume=true`]) {
      const body = await this.fetchText(path, {
        method: 'GET',
        headers: { ...this.headers(), Accept: 'text/event-stream' },
      });
      try {
        return this.extractReply(body);
      } catch (e) {
        log(`stream ${path} yielded no final reply (${e instanceof Error ? e.message : e}) — ${path === base ? 'retrying with resume' : 'giving up'}`);
      }
    }
    throw new Error('LibreChat stream ended without a final event.');
  }

  /** Buffer a whole response body under the reply timeout. LibreChat access
   *  tokens are short-lived and a full game outlives them — on a 401,
   *  re-login once and retry with the fresh token. */
  private async fetchText(path: string, init: RequestInit, retryAuth = true): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cli.replyTimeoutMs);
    try {
      const res = await fetch(`${this.cli.librechatUrl}${path}`, { ...init, signal: controller.signal });
      const text = await res.text();
      if (res.status === 401 && retryAuth) {
        log('token expired — re-logging in');
        await this.login();
        const headers = { ...(init.headers as Record<string, string>), Authorization: `Bearer ${this.token}` };
        return await this.fetchText(path, { ...init, headers }, false);
      }
      if (!res.ok) throw new Error(`LibreChat ${path} failed: ${res.status} ${text.slice(0, 300)}`);
      return text;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Parse a buffered SSE (or JSON) body and pull out the assistant's reply.
   *  The `final` event is authoritative (responseMessage.text + the ids);
   *  delta/content events are kept only as a fallback. An error event throws. */
  private extractReply(sseText: string): string {
    let accumulated = '';
    let finalText: string | null = null;
    let eventName = '';
    let errorMessage: string | null = null;

    const handleData = (raw: string): void => {
      let obj: any;
      try {
        obj = JSON.parse(raw);
      } catch {
        return;
      }
      if (eventName === 'error' || obj?.error === true) {
        errorMessage = String(obj?.message ?? obj?.text ?? raw).slice(0, 300);
        return;
      }
      if (obj?.final) {
        const conv = obj.conversation ?? {};
        if (typeof conv.conversationId === 'string') this.conversationId = conv.conversationId;
        const rm = obj.responseMessage ?? {};
        if (typeof rm.messageId === 'string') this.parentMessageId = rm.messageId;
        // This build leaves responseMessage.text empty and puts the reply in
        // responseMessage.content[] — read that first, and never let an empty
        // final overwrite the accumulated deltas.
        const contentText = Array.isArray(rm.content)
          ? rm.content
              .filter((p: any) => p?.type === 'text' && typeof p.text === 'string')
              .map((p: any) => p.text)
              .join('')
          : '';
        const t = contentText || (typeof rm.text === 'string' ? rm.text : '');
        if (t.trim()) finalText = t;
        return;
      }
      if (eventName === 'on_message_delta' || obj?.event === 'on_message_delta') {
        const parts = obj?.data?.delta?.content;
        if (Array.isArray(parts)) {
          for (const p of parts) {
            if (p?.type === 'text' && typeof p.text === 'string') accumulated += p.text;
          }
        }
        return;
      }
      // Content-update events ({type, text, index}) and classic cumulative {text}.
      if (typeof obj?.text === 'string') accumulated = obj.text;
    };

    for (const rawLine of sseText.split('\n')) {
      const line = rawLine.trimEnd();
      if (line === '') eventName = '';
      else if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) handleData(line.slice(5).trim());
    }
    if (errorMessage) throw new Error(`LibreChat stream error: ${errorMessage}`);
    const text = finalText ?? accumulated;
    if (!text.trim()) throw new Error('no final event and no delta text');
    return text;
  }
}

// ---------------------------------------------------------------------------
// Player (OpenAI-compatible chat completions)
// ---------------------------------------------------------------------------

type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string };

class Player {
  private messages: ChatMessage[] = [];

  constructor(private cli: Cli, systemPrompt: string) {
    this.messages.push({ role: 'system', content: systemPrompt });
  }

  /** Feed the player something it heard (assistant reply, or a private TABLE fact). */
  hear(content: string): void {
    this.messages.push({ role: 'user', content });
  }

  async respond(): Promise<string> {
    if (!this.cli.playerBaseUrl) {
      throw new Error('Set PLAYER_BASE_URL (or --player-base-url) to an OpenAI-compatible endpoint.');
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.cli.replyTimeoutMs);
    try {
      const res = await fetch(`${this.cli.playerBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(process.env.PLAYER_API_KEY ? { Authorization: `Bearer ${process.env.PLAYER_API_KEY}` } : {}),
        },
        body: JSON.stringify({ model: this.cli.playerModel, messages: this.messages, temperature: 0.6 }),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`Player endpoint failed: ${res.status} ${await res.text().catch(() => '')}`);
      const body = (await res.json()) as any;
      const text: unknown = body?.choices?.[0]?.message?.content;
      if (typeof text !== 'string' || !text.trim()) throw new Error('Player returned an empty reply.');
      this.messages.push({ role: 'assistant', content: text });
      return text;
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildPlayerPrompt(cli: Cli, guide: string): string {
  return [
    `You are ${cli.playerName}, a person playing a physical copy of the board game "${cli.game}" at your table, with a chat assistant that tracks shared state and plays the AI opponent(s). Everything you write is a chat message to that assistant, except the special lines described below.`,
    '',
    'HOW TO PLAY THE CONVERSATION',
    '- Open by asking the assistant to set up a game of this exact game for you. Give your name when asked. When asked for choices (your role, color, AI difficulty), choose yourself — pick medium difficulty unless the guide says otherwise.',
    '- Keep messages short and casual, like a person typing. One thing per message. Answer direct questions directly.',
    '- Play to WIN, following the strategy guide below. You make every decision that is yours to make.',
    '- The assistant is the rules authority: it reads the real rules from the game server. If you are unsure what is legal, ask it.',
    '- If the assistant seems to stop mid-task (no question for you, work clearly unfinished), just say "continue".',
    '',
    'SPECIAL LINES (read by the harness, never shown to the assistant)',
    '- ASK-TABLE — for physical facts you cannot know (your own draws and rolls). The harness answers with a line starting "TABLE:"; treat it as what physically happened and tell the assistant naturally. Two forms:',
    '    * ASK-TABLE: pick N of: name1; name2; name3; ... — when YOU know the candidate pool (drawing from your own deck): list every card that could be in it and the harness shuffles and tells you which N you drew. If you do not know the full pool, ask the assistant for the list first (reading your own cards is normal table behavior). Use this to establish your STARTING HAND at setup and for every later draw of your own. THE POOL IS YOUR JOB: it is your full deck MINUS every card you already drew or played (check your NOTE hand) — unless the game reshuffled your discard back in. A stale pool means drawing a card twice, which is your mistake, not a game bug.',
    '    * ASK-TABLE alone on a line — when even the pool is hidden from you; the game server synthesizes a valid outcome.',
    '  NEVER use ASK-TABLE for a decision — decisions are yours.',
    '- FLAG: <one sentence> — write one whenever something seems wrong. Watch for exactly these things:',
    '    1. A decision that was yours got made for you (your role, a discard, a target, an order) without anyone asking you.',
    '    2. What happened contradicts a rule you were taught earlier in this chat.',
    '    3. The state stops adding up: scores jump, cards duplicate or vanish, something you reported comes back different.',
    '    4. The assistant claims it did something but the follow-up shows it did not.',
    '  A FLAG line is a private note to the engineer. Also keep playing — flag it AND deal with it.',
    '- GAME-OVER: <verdict> — when the assistant says the game has ended, write this with a short paragraph: who won, whether the ending was handled correctly, and the biggest problems you hit all game.',
    '- NOTE: <anything> — a private memory line, stripped before sending. YOU are the only one tracking your own hand (the assistant cannot see it) — so every time you draw or play a card, write a NOTE line restating your full current hand. Also use it for AP left and plans. Never claim a card is in your hand unless your latest NOTE says so.',
    '',
    ...(cli.role
      ? [
          '',
          `THIS RUN'S IDENTITY: when setup offers you a role/faction/character choice, ask to play: ${cli.role}. This overrides any default the strategy guide names — its per-role advice still applies.`,
        ]
      : []),
    '',
    'STRATEGY GUIDE',
    guide.trim(),
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Table lookup (the game server, via MCP over HTTP)
// ---------------------------------------------------------------------------

class TableLookup {
  private client: Client | null = null;

  constructor(private cli: Cli) {}

  async connect(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StreamableHTTPClientTransport(new URL(this.cli.mcpUrl), {
      requestInit: {
        headers: {
          'ngrok-skip-browser-warning': '1',
          ...(process.env.ZEKEL_MCP_TOKEN ? { Authorization: `Bearer ${process.env.ZEKEL_MCP_TOKEN}` } : {}),
        },
      },
    });
    const client = new Client({ name: 'integration-bot', version: '0.1.0' });
    await client.connect(transport);
    this.client = client;
    return client;
  }

  private parseJsonContent(result: any): any {
    const text = result?.content?.[0]?.text ?? result?.contents?.[0]?.text;
    if (typeof text !== 'string') throw new Error('Unexpected MCP response shape.');
    return JSON.parse(text);
  }

  /** Newest session for the game — the one the assistant just created. */
  async findActiveSession(): Promise<{ session_id: string; active_player_id: string } | null> {
    const client = await this.connect();
    const res = await client.readResource({ uri: `game://${this.cli.game}/sessions` });
    const body = this.parseJsonContent(res);
    const sessions: any[] = Array.isArray(body?.sessions) ? body.sessions : [];
    if (sessions.length === 0) return null;
    const newest = [...sessions].sort((a, b) =>
      String(a?.created_at ?? '').localeCompare(String(b?.created_at ?? '')),
    )[sessions.length - 1];
    if (!newest?.session_id) return null;
    return { session_id: String(newest.session_id), active_player_id: String(newest.active_player_id ?? '') };
  }

  /** Resolve ASK-TABLE: a valid outcome for the fact the active (human) seat owes.
   *  suggest_move is read-only and works for any seat; when the player owes a
   *  report, they are the active seat, so active_player_id is the right target. */
  async lookupFact(): Promise<string> {
    const session = await this.findActiveSession();
    if (!session) return 'TABLE: no game session exists on the server yet — tell the assistant to create one first.';
    try {
      const client = await this.connect();
      const res = await client.callTool({
        name: 'suggest_move',
        arguments: { session_id: session.session_id, player_id: session.active_player_id },
      });
      const body = this.parseJsonContent(res);
      const move = body?.suggested_move ?? body?.move ?? body;
      return (
        'TABLE: here is the physical outcome (a valid draw/roll synthesized by the game server). ' +
        'State it to the assistant naturally, in your own words, as the thing that just happened at your table. ' +
        `Do not mention the server or this note. Outcome: ${JSON.stringify(move)}`
      );
    } catch (e) {
      return `TABLE: lookup failed (${e instanceof Error ? e.message : String(e)}) — tell the assistant you are not sure and ask it what your options are.`;
    }
  }

  async close(): Promise<void> {
    await this.client?.close().catch(() => undefined);
  }
}

// ---------------------------------------------------------------------------
// Marker handling
// ---------------------------------------------------------------------------

type ParsedPlayerReply = {
  outgoing: string;
  flags: string[];
  askTable: boolean;
  askPick: { count: number; options: string[] } | null;
  gameOver: string | null;
};

export function parsePlayerReply(rawInput: string): ParsedPlayerReply {
  // Strip reasoning tokens the player model may emit inline: well-formed
  // <think>…</think> blocks first, then anything before a stray closing tag
  // (Ollama sometimes drops the opening tag, duplicating the message).
  let raw = rawInput.replace(/<think>[\s\S]*?<\/think>/g, '');
  const strayClose = raw.lastIndexOf('</think>');
  if (strayClose >= 0) raw = raw.slice(strayClose + '</think>'.length);
  const flags: string[] = [];
  let askTable = false;
  let askPick: ParsedPlayerReply['askPick'] = null;
  let gameOver: string | null = null;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    const pick = /^ASK-TABLE:\s*pick\s+(\d+)\s+of:\s*(.+)$/i.exec(t);
    if (t.startsWith('FLAG:')) flags.push(t.slice(5).trim());
    else if (t.startsWith('NOTE:')) continue; // private memory line, never sent
    else if (pick) {
      const options = pick[2]!.split(';').map((s) => s.trim()).filter(Boolean);
      askPick = { count: Math.min(Number(pick[1]), options.length), options };
    } else if (t === 'ASK-TABLE') askTable = true;
    else if (t.startsWith('GAME-OVER:')) gameOver = t.slice(10).trim();
    else kept.push(line);
  }
  return { outgoing: kept.join('\n').trim(), flags, askTable, askPick, gameOver };
}

/** The player's shuffle: uniform sample without replacement. */
export function drawFrom(options: string[], count: number): string[] {
  const pool = [...options];
  const drawn: string[] = [];
  while (drawn.length < count && pool.length > 0) {
    const i = Math.floor(Math.random() * pool.length);
    drawn.push(...pool.splice(i, 1));
  }
  return drawn;
}

// ---------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------

async function runCheck(cli: Cli): Promise<void> {
  log(`check: logging into ${cli.librechatUrl} …`);
  const chat = new LibreChatClient(cli);
  await chat.login();
  log('check: login OK');
  const user = (await chat.get('/api/user')) as any;
  log(`check: user = ${user?.email ?? user?.username ?? '(unknown shape)'}`);
  try {
    const endpoints = (await chat.get('/api/endpoints')) as Record<string, unknown>;
    log(`check: endpoints = ${Object.keys(endpoints ?? {}).join(', ')}`);
  } catch (e) {
    log(`check: /api/endpoints failed (${e instanceof Error ? e.message : e}) — not fatal`);
  }
  // List agents so the operator can pick --agent-id (shape varies a little by
  // build: {data:[...]} or a bare array).
  try {
    const raw = (await chat.get('/api/agents')) as any;
    const agents: any[] = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? raw.data : [];
    if (agents.length === 0) log('check: no agents visible to this account — create/share one in the LibreChat UI');
    for (const a of agents) log(`check: agent id=${a?.id ?? a?._id ?? '?'} name="${a?.name ?? '?'}"`);
  } catch (e) {
    log(`check: /api/agents failed (${e instanceof Error ? e.message : e}) — find the agent id in the LibreChat UI URL instead`);
  }
  log(`check: connecting MCP at ${cli.mcpUrl} …`);
  const table = new TableLookup(cli);
  const client = await table.connect();
  const tools = await client.listTools();
  log(`check: MCP OK — ${tools.tools.length} tools (${tools.tools.some((t) => t.name === 'suggest_move') ? 'suggest_move present' : 'WARNING: suggest_move MISSING'})`);
  const sessions = await table.findActiveSession();
  log(`check: newest ${cli.game} session = ${sessions ? sessions.session_id : '(none yet — fine)'}`);
  await table.close();
  log('check: all plumbing OK');
}

async function runGame(cli: Cli): Promise<void> {
  const guidePath = resolve(cli.guidePath);
  if (!existsSync(guidePath)) {
    throw new Error(
      `No strategy guide at ${guidePath}. Write it first — see docs/integration-runbook.md ("Write the strategy guide first").`,
    );
  }
  const guide = readFileSync(guidePath, 'utf8');

  mkdirSync(cli.outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const transcriptPath = resolve(cli.outDir, `integration-${cli.game}-${stamp}.jsonl`);
  const summaryPath = resolve(cli.outDir, `integration-${cli.game}-${stamp}.json`);
  const record = (entry: Record<string, unknown>): void => {
    appendFileSync(transcriptPath, `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`);
  };

  const chat = new LibreChatClient(cli);
  await chat.login();
  const table = new TableLookup(cli);
  const player = new Player(cli, buildPlayerPrompt(cli, guide));

  const allFlags: { exchange: number; flag: string }[] = [];
  let gameOver: string | null = null;
  let exchanges = 0;

  player.hear('You are opening the chat. Send your first message to the assistant.');

  try {
    while (exchanges < cli.maxExchanges && gameOver === null) {
      // Player composes (resolving ASK-TABLE privately first, bounded to avoid loops).
      let parsed: ParsedPlayerReply | null = null;
      for (let attempt = 0; attempt < 3; attempt++) {
        const raw = await player.respond();
        parsed = parsePlayerReply(raw);
        for (const f of parsed.flags) {
          allFlags.push({ exchange: exchanges, flag: f });
          record({ role: 'flag', text: f });
          log(`[${exchanges}] FLAG ${clip(f)}`);
        }
        if (parsed.gameOver !== null) break;
        if (!parsed.askTable && !parsed.askPick) break;
        const fact = parsed.askPick
          ? `TABLE: you shuffled and drew: ${drawFrom(parsed.askPick.options, parsed.askPick.count).join('; ')}. That is your physical outcome — tell the assistant naturally and update your NOTE hand.`
          : await table.lookupFact();
        record({ role: 'table', text: fact });
        log(`[${exchanges}] table> ${clip(fact)}`);
        player.hear(fact);
        parsed = null;
      }
      if (parsed?.gameOver !== null && parsed !== null) {
        gameOver = parsed.gameOver;
        record({ role: 'game_over', text: gameOver });
        log(`[${exchanges}] GAME-OVER ${clip(gameOver ?? '')}`);
        break;
      }
      const outgoing = parsed?.outgoing || 'continue';

      exchanges += 1;
      record({ role: 'player', text: outgoing });
      log(`[${exchanges}] player> ${clip(outgoing)}`);

      let reply: string;
      try {
        reply = await chat.send(outgoing);
      } catch (e) {
        // Last resort: the generation died server-side and no reply was ever
        // persisted. A real human's move here is a nudge — send "continue"
        // once in the same conversation (history retains the original message
        // if it landed; the assistant re-derives what's owed from next_step).
        log(`send failed (${e instanceof Error ? e.message : e}) — nudging with "continue"`);
        record({ role: 'player', text: 'continue' });
        reply = await chat.send('continue');
      }
      record({ role: 'assistant', text: reply });
      log(`[${exchanges}] assistant< ${clip(reply)}`);
      player.hear(reply);
    }
  } finally {
    await table.close();
    const summary = {
      game: cli.game,
      role: cli.role ?? null,
      player_model: cli.playerModel,
      agent_id: cli.agentId ?? null,
      endpoint: cli.agentId ? 'agents' : cli.endpoint,
      exchanges,
      completed: gameOver !== null,
      game_over_verdict: gameOver,
      flags: allFlags,
      transcript: transcriptPath,
    };
    writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  }

  if (gameOver === null) {
    log(`stopped at the ${cli.maxExchanges}-exchange cap WITHOUT reaching game over — read the transcript tail.`);
  }
}

export async function main(argv: string[]): Promise<void> {
  const cli = parseCli(argv);
  if (cli.check) await runCheck(cli);
  else await runGame(cli);
}

