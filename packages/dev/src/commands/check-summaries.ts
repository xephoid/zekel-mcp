// Checks a game's spoken text against docs/spoken-narration.md: plays whole
// all-AI games through the game module (the AI's own choices, so every
// mechanic the AI uses gets spoken) and runs every move's state_summary and
// every AI narration through core/spokenText.ts. Post-port runs this; a clean
// result is required for a game zekel Live reads aloud.
//
//   pnpm tsx scripts/check-summaries.ts --game=fractured-fist [--games=5] [--players=2]
//
// Exit code 1 when any string breaks a rule. Mechanical checks only: a person
// still reads a sample to judge whether it sounds right aloud.

import { getGame, registerGame } from '@zekel/mcp';
import type { PlayerConfig, SessionState } from '@zekel/game-kit';
import { checkSpokenText } from '../core/spokenText.js';
import type { DevSetup } from './setup.js';

export async function main(argv: string[], setup: DevSetup): Promise<void> {
  const arg = (name: string, fallback: string): string => {
    const found = argv.find((a) => a.startsWith(`--${name}=`));
    return found ? found.slice(name.length + 3) : fallback;
  };
  for (const g of setup.games ?? []) registerGame(g);
  const gameId = arg('game', '');
  if (!gameId) throw new Error('Usage: tsx scripts/check-summaries.ts --game=<id> [--games=N] [--players=N]');
  const game = getGame(gameId);
  const games = Number(arg('games', '5'));
  const players = Number(arg('players', String(game.minPlayers)));
  const MAX_MOVES = 3000;

  const byRule = new Map<string, { count: number; examples: string[] }>();
  let strings = 0;
  const note = (kind: string, text: string, seatIds: string[]) => {
    strings += 1;
    for (const p of checkSpokenText(text, seatIds)) {
      const key = `${kind}: ${p.rule}`;
      const entry = byRule.get(key) ?? { count: 0, examples: [] };
      entry.count += 1;
      if (entry.examples.length < 3) entry.examples.push(`${p.detail} — ${JSON.stringify(text.slice(0, 160))}`);
      byRule.set(key, entry);
    }
  };

  for (let seed = 1; seed <= games; seed++) {
    const seats: PlayerConfig[] = Array.from({ length: players }, (_, i) => ({
      player_id: `p${i + 1}`,
      kind: 'ai',
      difficulty: 'medium',
    }));
    const seatIds = seats.map((s) => s.player_id);
    let state = game.createSession(seats, { seed } as never) as SessionState<unknown>;
    state.sessionId = `check-${seed}`;
    for (let i = 0; i < MAX_MOVES && !game.isGameOver(state); i++) {
      const active = state.activePlayerId;
      const pick = await game.getAIMove(state, active, 'medium');
      const result = game.applyMove(state, active, pick.move);
      note('state_summary', result.summary, seatIds);
      if (pick.narration && pick.narration !== result.summary) note('narration', pick.narration, seatIds);
      state = result.newState;
    }
  }

  process.stdout.write(`${gameId}: checked ${strings} spoken strings from ${games} all-AI games of ${players} players.\n`);
  if (byRule.size === 0) {
    process.stdout.write('No problems.\n');
  } else {
    for (const [rule, { count, examples }] of [...byRule].sort((a, b) => b[1].count - a[1].count)) {
      process.stdout.write(`\n${rule} — ${count}\n`);
      for (const e of examples) process.stdout.write(`  ${e}\n`);
    }
    process.exitCode = 1;
  }
}
