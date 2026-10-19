import { describe, expect, it } from 'vitest';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ReportVoice } from '@zekel/game-kit';
import { registerGame } from '../../core/registry.js';
import { BOARD_VOICE } from '../tools.js';
import { makeLuckyTicTacToe } from './luckyTicTacToe.js';
import { connect } from './testServer.js';

// BOARD_VOICE must stay byte-identical to the report_to_human strings that
// were inlined in tools.ts before the ReportVoice extraction (2026-07-07).
// These strings are load-bearing prompt text for weak clients — the desync
// gate was verified against them. Changing one is a desync-retrigger event,
// not a copy edit: see CLAUDE.md "Cross-cutting changes → re-verify".
describe('BOARD_VOICE snapshot', () => {
  it('apply_move confirm string is unchanged', () => {
    expect(BOARD_VOICE.applyMoveConfirm).toBe(
      'Confirm the human\'s move briefly — one line restating what they declared and what state_summary says changed. Do NOT recite their hand, the board, the supply, or scores; they can see those.',
    );
  });

  it('get_ai_move full-report string is unchanged', () => {
    expect(BOARD_VOICE.aiMoveFull).toBe(
      'REPORT THIS AI MOVE TO THE HUMAN IN FULL: relay state_summary verbatim — every board-changing fact (what was played, rolled, captured, built, moved, bought, drawn or discarded; WHERE each piece/card goes; and any score/resource change) — in plain game terms, nothing omitted and no flavor, so the human can update their physical board. One get_ai_move is ONE move: if next_step still shows this AI is up, keep calling it.',
    );
  });

  it('run_ai_turn strings are unchanged', () => {
    expect(BOARD_VOICE.runAiTurnNone).toBe(
      'No AI moves were played this call — follow next_step.',
    );
    expect(BOARD_VOICE.runAiTurn(3, false)).toBe(
      'REPORT THESE 3 AI MOVE(S) TO THE HUMAN NOW, IN ORDER: for EACH entry in `moves`, relay its `state_summary` IN FULL and verbatim — every board-changing fact (what moved where; who/what was captured, blasted, built, bought, played, moved, drawn or discarded; and every piece / score / resource change) — in plain game terms, nothing omitted and no flavor added, so the human can update their physical board. Do NOT compress an AI turn into a summary like "the AI took its turn". Then follow next_step: it is a human\'s turn — call get_legal_moves for that player and relay their options.',
    );
    expect(BOARD_VOICE.runAiTurn(1, true)).toBe(
      'REPORT THESE 1 AI MOVE(S) TO THE HUMAN NOW, IN ORDER: for EACH entry in `moves`, relay its `state_summary` IN FULL and verbatim — every board-changing fact (what moved where; who/what was captured, blasted, built, bought, played, moved, drawn or discarded; and every piece / score / resource change) — in plain game terms, nothing omitted and no flavor added, so the human can update their physical board. Do NOT compress an AI turn into a summary like "the AI took its turn". Then report the game result.',
    );
  });
});

// A game's own reportVoice replaces BOARD_VOICE on every response for that
// game's sessions (Game.reportVoice), and only for that game.
const VOICE: ReportVoice = {
  applyMoveConfirm: 'CUSTOM apply_move voice',
  aiMoveFull: 'CUSTOM get_ai_move voice',
  runAiTurnNone: 'CUSTOM run_ai_turn none',
  runAiTurn: (n, over) => `CUSTOM run_ai_turn ${n} ${over}`,
};

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<Record<string, any>> {
  const r = (await client.callTool({ name, arguments: args })) as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0]!.text) as Record<string, any>;
}

describe("a game's own voice", () => {
  it('replaces the default on apply_move, get_ai_move and run_ai_turn, for that game only', async () => {
    registerGame(makeLuckyTicTacToe({ id: 'voiced-tic-tac-toe', reportVoice: VOICE }));
    const client = await connect();
    const created = await call(client, 'create_session', {
      game_id: 'voiced-tic-tac-toe',
      players: [{ player_id: 'p1', kind: 'human', name: 'Ada' }, { player_id: 'p2', kind: 'ai', difficulty: 'easy' }],
      options: { seed: 1 },
    });
    const sid = created.session_id as string;
    const marks = await call(client, 'apply_move', { session_id: sid, player_id: 'p1', move: { type: 'assign_setup_choices', selections: { p1: 'O', p2: 'X' } } });
    expect(marks.report_to_human).toBe(VOICE.applyMoveConfirm);
    await call(client, 'apply_move', { session_id: sid, player_id: 'p1', move: { type: 'report_lucky_card', square: 'A1' } });
    const one = await call(client, 'get_ai_move', { session_id: sid, player_id: 'p2' });
    expect(one.report_to_human).toBe(VOICE.aiMoveFull);
    await call(client, 'apply_move', { session_id: sid, player_id: 'p1', move: { type: 'place', square: 'C3' } });
    const turn = await call(client, 'run_ai_turn', { session_id: sid, player_id: 'p2' });
    expect(turn.report_to_human).toBe(VOICE.runAiTurn(turn.moves.length, false));

    const plain = await call(client, 'create_session', {
      game_id: 'lucky-tic-tac-toe',
      players: [{ player_id: 'p1', kind: 'human', name: 'Ada' }, { player_id: 'p2', kind: 'ai', difficulty: 'easy' }],
    });
    const plainMarks = await call(client, 'apply_move', { session_id: plain.session_id, player_id: 'p1', move: { type: 'assign_setup_choices', selections: { p1: 'X', p2: 'O' } } });
    expect(plainMarks.report_to_human).toBe(BOARD_VOICE.applyMoveConfirm);
    await client.close();
  });
});
