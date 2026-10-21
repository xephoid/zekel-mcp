// Choice coverage — does a human seat actually get asked the decisions the
// rules give them?
//
// This plays a game in-process (no compiled server, no child process) with one
// seat driven as a human, and records every decision that seat was actually
// offered. Compared against the game's choice catalog (Game.getChoiceCatalog),
// a decision marked `player` that never shows up means the engine settled it
// without asking — the bug that shipped in Wonderland's War and that neither
// the all-AI harness nor the human-seat sweep can see, because a decision that
// is never offered produces nothing to observe.
//
// It runs in-process on purpose: that keeps it inside `pnpm test`, where it
// fails the build, rather than in a gate-time script someone has to remember.
//
// Whose turn it is comes from buildNextStep — the same authority the real
// client follows — so a game whose pendings are owed to a seat other than
// `activePlayerId` is handled without per-game knowledge.

import type { AnyGame } from '@zekel/mcp';
import type { PlayerConfig, SessionState } from '@zekel/game-kit';
import { buildNextStep } from '@zekel/mcp/mcp/nextStep';

export interface CoverageResult {
  gameId: string;
  playerCount: number;
  gamesPlayed: number;
  gamesCompleted: number;
  /** Catalog ids the human seat was actually asked. */
  covered: string[];
  /** Player-owned catalog ids the human seat was NEVER asked. */
  missed: string[];
  /**
   * Player-owned ids declared as only coming up under some condition (see
   * PlayerChoice.dependsOn) that this run did not reach. Reported, not failed —
   * but worth reading, because this is where a real bug could hide.
   */
  conditionalGaps: string[];
  /**
   * Player-owned ids that playing the game cannot check, because the choice is
   * made when the session is created (`resolvedBy: ['options.x']`). Reported so
   * they stay visible rather than counting as passed.
   */
  notCheckable: string[];
  /** Decisions the human was asked that no catalog row claims. */
  unlisted: string[];
  /**
   * Rows naming a move field (`distinguishedBy`) where that move WAS offered,
   * repeatedly, but never once carried the field. Almost always the field name
   * is wrong — which would make the row impossible to cover, and so a silent
   * pass. Three Bacon Project rows were written this way before this check
   * existed.
   */
  suspectFields: string[];
  /** Games that stopped early — a report the driver could not supply, or a stall. */
  incomplete: number;
  /**
   * The game's AI opponents need a service that is not running (an LLM backend),
   * so nothing could be played. Not a pass and not a failure — unmeasured.
   */
  aiUnavailable: boolean;
  notes: string[];
}

const STEP_LIMIT = 6000;

function seats(count: number, humanSeat: number): PlayerConfig[] {
  return Array.from({ length: count }, (_, i) =>
    i === humanSeat
      ? { player_id: `p${i + 1}`, kind: 'human' as const, name: 'You' }
      : { player_id: `p${i + 1}`, kind: 'ai' as const, difficulty: 'medium' },
  );
}

/**
 * Play `games` games of `game` at `playerCount`, rotating which seat is the
 * human, and report which catalog decisions that seat was actually offered.
 */
export async function measureChoiceCoverage(
  game: AnyGame,
  playerCount: number,
  games = 8,
  firstSeed = 1,
): Promise<CoverageResult> {
  const catalog = game.getChoiceCatalog?.() ?? [];
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const covered = new Set<string>();
  const unlisted = new Set<string>();
  // id -> how many times one of its move types was offered without the field.
  const fieldMisses = new Map<string, number>();
  const notes: string[] = [];
  let completed = 0;
  let incomplete = 0;
  let aiUnavailable = false;

  for (let g = 0; g < games; g++) {
    const seed = firstSeed + g;
    const humanSeat = g % playerCount;
    const humanId = `p${humanSeat + 1}`;
    let session: SessionState<unknown>;
    try {
      session = game.createSession(seats(playerCount, humanSeat), { seed });
    } catch (e) {
      notes.push(`seed ${seed}: could not create a session — ${(e as Error).message}`);
      incomplete++;
      continue;
    }
    session = { ...session, sessionId: `coverage-${seed}` };

    let steps = 0;
    let stopped = false;
    while (!stopped && steps++ < STEP_LIMIT) {
      const over = game.isGameOver(session);
      if (over) break;
      const step = buildNextStep(session, null, game);
      const actor = step.active_player_id;
      if (!actor) {
        notes.push(`seed ${seed}: nobody is on the clock (status ${step.status})`);
        break;
      }

      if (actor !== humanId) {
        // An AI seat: let the game play it.
        try {
          const r = await game.getAIMove(session, actor, 'medium');
          session = game.applyMove(session, actor, r.move).newState;
        } catch (e) {
          // Some games have an LLM-backed AI (Agent Hunter talks to a local
          // Ollama). With no backend running, every AI move waits for a network
          // timeout, so give up on the whole game rather than grind through it.
          if ((e as { error_code?: string }).error_code === 'AI_BACKEND_UNAVAILABLE') {
            aiUnavailable = true;
            return {
              gameId: game.id,
              playerCount,
              gamesPlayed: g,
              gamesCompleted: completed,
              covered: [...covered].sort(),
              missed: [],
              conditionalGaps: [],
              notCheckable: [],
              unlisted: [],
              suspectFields: [],
              incomplete,
              aiUnavailable,
              notes: [
                `${game.id} needs a running AI backend to play its opponents, so play cannot ` +
                  'check its choices here.',
              ],
            };
          }
          notes.push(`seed ${seed}: the AI seat ${actor} could not move — ${(e as Error).message}`);
          stopped = true;
        }
        continue;
      }

      // The human seat. Record what they are being asked BEFORE answering.
      const owed = game.getChoiceOwed?.(session, humanId) ?? null;
      const legal = game.getLegalMoves(session, humanId);
      if (owed !== null) {
        if (byId.has(owed)) covered.add(owed);
        else unlisted.add(owed);
      }
      // Always match the offered moves too, even when the game named an owed
      // choice: a pending can be open while other named moves are ALSO on
      // offer (Star Wars: Rebellion offers report_rebel_base alongside a
      // pending card choice), and treating this as either/or lost those.
      // `distinguishedBy` handles games that bundle several decisions into the
      // fields of one move.
      const offered = legal.map((m) => m.move as Record<string, unknown>);
      for (const c of catalog) {
        if (c.owner !== 'player') continue;
        const typeOffered = offered.filter((m) => typeof m?.type === 'string' && c.resolvedBy.includes(m.type));
        const hit = typeOffered.some(
          (m) => c.distinguishedBy === undefined || m[c.distinguishedBy] !== undefined,
        );
        if (hit) covered.add(c.id);
        else if (c.distinguishedBy !== undefined && typeOffered.length > 0) {
          fieldMisses.set(c.id, (fieldMisses.get(c.id) ?? 0) + typeOffered.length);
        }
      }

      if (legal.length === 0) {
        notes.push(`seed ${seed}: the human seat is owed a move but nothing was offered`);
        incomplete++;
        stopped = true;
        continue;
      }

      // Answer it. Some games list TEMPLATE moves with blank fields a person
      // would fill in (Warble's create_character wants a name), so try the
      // game's own suggestion first — the same order engineBot uses.
      let applied = false;
      const suggested = game.getSuggestedMove?.(session, humanId) ?? null;
      if (suggested) {
        try {
          session = game.applyMove(session, humanId, suggested.move).newState;
          applied = true;
        } catch {
          /* fall through to the listed options */
        }
      }
      const start = (g + steps) % legal.length;
      for (let i = 0; i < legal.length && !applied; i++) {
        const candidate = legal[(start + i) % legal.length]!;
        try {
          session = game.applyMove(session, humanId, candidate.move).newState;
          applied = true;
        } catch {
          /* try the next option */
        }
      }
      if (!applied) {
        // Every listed option was refused — usually a physical report whose real
        // value only the server knows (a drawn card, a die roll).
        const synthesized = game.autoResolveReport?.(session, humanId) ?? null;
        if (synthesized) {
          try {
            session = game.applyMove(session, humanId, synthesized.move).newState;
            applied = true;
          } catch (e) {
            notes.push(`seed ${seed}: the synthesized report was refused — ${(e as Error).message}`);
          }
        }
      }
      if (!applied) {
        incomplete++;
        stopped = true;
      }
    }

    if (steps >= STEP_LIMIT) {
      notes.push(`seed ${seed}: hit the ${STEP_LIMIT}-step limit without finishing`);
      incomplete++;
    } else if (game.isGameOver(session)) {
      completed++;
    }
  }

  // A choice made through a create_session option leaves no trace in play, so it
  // is reported rather than checked.
  const madeAtSetup = (ids: string[]): boolean =>
    ids.length > 0 && ids.every((t) => t.startsWith('options.'));
  const owed = catalog.filter((c) => c.owner === 'player' && !covered.has(c.id));
  const missed = owed
    .filter((c) => !madeAtSetup(c.resolvedBy) && c.dependsOn === undefined)
    .map((c) => c.id);
  // Declared as only coming up under some condition (a particular god, species,
  // power). Reported so they stay visible rather than counting as passed.
  const conditionalGaps = owed
    .filter((c) => c.dependsOn !== undefined)
    .map((c) => `${c.id} (needs ${c.dependsOn})`);
  const notCheckable = catalog
    .filter((c) => c.owner === 'player' && madeAtSetup(c.resolvedBy))
    .map((c) => c.id);
  return {
    gameId: game.id,
    playerCount,
    gamesPlayed: games,
    gamesCompleted: completed,
    covered: [...covered].sort(),
    missed,
    conditionalGaps,
    notCheckable,
    aiUnavailable,
    unlisted: [...unlisted].sort(),
    suspectFields: [...fieldMisses]
      .filter(([id]) => !covered.has(id))
      .filter(([, n]) => n >= 25)
      .map(([id, n]) => `${id} (its move was offered ${n} times, never with the field it names)`),
    incomplete,
    notes,
  };
}
