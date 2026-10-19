// End-to-end check of the built server with no game of its own: start the
// example game (examples/race-to-ten.mjs) over stdio and play a whole game, a
// human seat against an AI seat, through the real MCP tools. Build first.
//   pnpm build && pnpm smoke

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn('node', [resolve(root, 'examples/race-to-ten.mjs')], {
  env: { ...process.env, SESSION_STORE: 'memory' },
  stdio: ['pipe', 'pipe', 'inherit'],
});
let buffer = '';
const waiting = new Map();
let nextId = 0;
child.stdout.on('data', (chunk) => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (line.trim()) {
      const msg = JSON.parse(line);
      waiting.get(msg.id)?.(msg);
    }
  }
});
const rpc = (method, params) =>
  new Promise((done) => {
    const id = ++nextId;
    waiting.set(id, done);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
async function tool(name, args) {
  const res = (await rpc('tools/call', { name, arguments: args })).result;
  return { isError: !!res.isError, body: JSON.parse(res.content[0].text) };
}
function check(ok, what) {
  if (!ok) {
    console.error(`SMOKE FAILED: ${what}`);
    child.kill();
    process.exit(1);
  }
  console.log(`ok - ${what}`);
}

await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

const tools = (await rpc('tools/list', {})).result.tools.map((t) => t.name);
check(['create_session', 'apply_move', 'run_ai_turn', 'get_state', 'join_session', 'undo'].every((t) => tools.includes(t)), `tools listed (${tools.length})`);

const games = (await tool('list_games', {})).body;
const gameIds = (games.games ?? games).map((g) => g.game_id ?? g.id);
check(gameIds.length === 1 && gameIds[0] === 'race-to-ten', `list_games shows only the registered game (${gameIds.join(', ')})`);

const created = await tool('create_session', {
  game_id: 'race-to-ten',
  players: [
    { player_id: 'p1', kind: 'human', name: 'Smoke' },
    { player_id: 'p2', kind: 'ai', difficulty: 'easy' },
  ],
});
check(!created.isError && created.body.session_id, 'create_session');
const sid = created.body.session_id;
check(created.body.next_step?.status === 'human_to_move', `next_step says the human is up (${created.body.next_step?.status})`);

const bad = await tool('apply_move', { session_id: sid, player_id: 'p1', move: { type: 'add', amount: 3 } });
check(bad.isError && bad.body.error_code === 'ILLEGAL_MOVE', `an illegal move is refused with the game's error (${bad.body.error_code})`);

const wrongSeat = await tool('get_ai_move', { session_id: sid, player_id: 'p2' });
check(wrongSeat.isError && wrongSeat.body.error_code === 'NOT_YOUR_TURN', `the AI cannot move on the human's turn (${wrongSeat.body.error_code})`);

let over = false;
for (let round = 0; round < 10 && !over; round++) {
  const legal = await tool('get_legal_moves', { session_id: sid, player_id: 'p1' });
  check(!legal.isError && legal.body.legal_moves?.length > 0, `round ${round + 1}: get_legal_moves offers ${legal.body.legal_moves?.length} moves`);
  const moved = await tool('apply_move', { session_id: sid, player_id: 'p1', move_id: legal.body.legal_moves[0].move_id });
  check(!moved.isError, `round ${round + 1}: apply_move by move_id (${moved.body.state_summary})`);
  if (moved.body.next_step?.status === 'game_over') break;
  const ai = await tool('run_ai_turn', { session_id: sid, player_id: 'p2' });
  check(!ai.isError && ai.body.moves?.length >= 1, `round ${round + 1}: run_ai_turn played ${ai.body.moves?.length} move(s)`);
  over = ai.body.next_step?.status === 'game_over';
}

const final = await tool('is_game_over', { session_id: sid });
check(!final.isError && final.body.game_over === true, `the game finished (${final.body.summary ?? JSON.stringify(final.body).slice(0, 80)})`);

const undone = await tool('undo', { session_id: sid });
check(!undone.isError, 'undo works on the finished game');

console.log('SMOKE OK');
child.kill();
