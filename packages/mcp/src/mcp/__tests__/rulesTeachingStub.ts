// Shared stub game for the rules-teaching test suite (docs/rules-teaching.md):
// sectioned rules (M0), move gates + grey list (M1), teaching channels (M2),
// preferences (M3). Deliberately tiny: two seats, four move types —
//   advance      — always legal; passes the turn
//   rest         — always legal; +1 Energy
//   power_strike — GATED: needs 2 Energy (spends 2)
//   celebrate    — ROUTINE: only legal in the 'victory' phase (never in 'main')
// NOT a real game; it exists so mcp-layer tests can construct exact states.

import type {
  ApplyMoveResult,
  Game,
  LegalMove,
  PlayerConfig,
  RuleSection,
  SessionState,
} from '@zekel/game-kit';
import { GameError } from '@zekel/game-kit';
import { renderRulesText } from '@zekel/game-kit';

export interface StubState {
  energy: Record<string, number>;
  phase: 'main' | 'victory';
}

export interface StubMove {
  type: 'advance' | 'rest' | 'power_strike' | 'celebrate';
}

export const STUB_SECTIONS: RuleSection[] = [
  {
    id: 'advancing',
    title: 'Advancing',
    text: 'Advance ends your turn and passes play to the next player.',
    tags: { move_types: ['advance'] },
  },
  {
    id: 'resting',
    title: 'Resting',
    text: 'Rest gains you 1 Energy. Energy has no cap.',
    tags: { move_types: ['rest'] },
  },
  {
    id: 'power-strike',
    title: 'Power Strike',
    text: 'Power Strike costs 2 Energy. You cannot Power Strike with fewer than 2 Energy.',
    tags: { move_types: ['power_strike'] },
  },
  {
    id: 'celebrating',
    title: 'Celebrating',
    text: 'Celebrate is only possible during the victory phase.',
    tags: { move_types: ['celebrate'], phases: ['victory'] },
  },
  {
    id: 'main-phase',
    title: 'The Main Phase',
    text: 'During the main phase, players alternate turns taking one action each.',
    tags: { phases: ['main'] },
  },
];

function nextPlayer(state: SessionState<StubState>): string {
  const ids = state.players.map((p) => p.player_id);
  const i = ids.indexOf(state.activePlayerId);
  return ids[(i + 1) % ids.length] ?? state.activePlayerId;
}

export const rulesTeachingStub: Game<StubState, StubMove> = {
  id: 'rules-teaching-stub',
  name: 'Rules Teaching Stub',
  description: 'Test-only stub game for the rules-teaching infra.',
  minPlayers: 1,
  maxPlayers: 2,
  supportsAI: true,
  hasHiddenInformation: false,
  optionsSchema: { type: 'object' },
  moveSchema: {
    oneOf: [
      { type: 'object', properties: { type: { const: 'advance' } }, required: ['type'] },
      { type: 'object', properties: { type: { const: 'rest' } }, required: ['type'] },
      { type: 'object', properties: { type: { const: 'power_strike' } }, required: ['type'] },
      { type: 'object', properties: { type: { const: 'celebrate' } }, required: ['type'] },
    ],
  },
  version: '1.0.0',

  createSession(players: PlayerConfig[]): SessionState<StubState> {
    const energy: Record<string, number> = {};
    for (const p of players) energy[p.player_id] = 0;
    return {
      sessionId: '',
      gameId: 'rules-teaching-stub',
      players,
      activePlayerId: players[0]!.player_id,
      turnNumber: 1,
      gameState: { energy, phase: 'main' },
      moveLog: [],
      createdAt: new Date().toISOString(),
    };
  },

  getLegalMoves(state, playerId): LegalMove<StubMove>[] {
    if (state.activePlayerId !== playerId) return [];
    const energy = state.gameState.energy[playerId] ?? 0;
    const moves: LegalMove<StubMove>[] = [
      { move_id: 'advance', description: 'Advance (end your turn)', move: { type: 'advance' } },
      { move_id: 'rest', description: 'Rest (+1 Energy)', move: { type: 'rest' } },
    ];
    if (energy >= 2) {
      moves.push({
        move_id: 'power-strike',
        description: 'Power Strike (spend 2 Energy)',
        move: { type: 'power_strike' },
      });
    }
    if (state.gameState.phase === 'victory') {
      moves.push({ move_id: 'celebrate', description: 'Celebrate', move: { type: 'celebrate' } });
    }
    return moves;
  },

  getPublicView(state) {
    return { energy: state.gameState.energy, phase: state.gameState.phase };
  },
  getPlayerView(state) {
    return { energy: state.gameState.energy, phase: state.gameState.phase };
  },
  isGameOver() {
    return null;
  },

  applyMove(state, playerId, move): ApplyMoveResult<StubState> {
    const s: SessionState<StubState> = {
      ...state,
      gameState: { ...state.gameState, energy: { ...state.gameState.energy } },
    };
    const energy = s.gameState.energy[playerId] ?? 0;
    switch (move.type) {
      case 'advance':
        s.activePlayerId = nextPlayer(s);
        s.turnNumber += 1;
        return { newState: s, summary: `${playerId} advances; play passes.` };
      case 'rest':
        s.gameState.energy[playerId] = energy + 1;
        return { newState: s, summary: `${playerId} rests (+1 Energy).` };
      case 'power_strike': {
        if (energy < 2) {
          // Engine-level gate — the mcp layer's rejection-enrichment test forces
          // this path by submitting the move directly.
          throw new GameError('ILLEGAL_MOVE', 'power_strike requires 2 Energy.');
        }
        s.gameState.energy[playerId] = energy - 2;
        return { newState: s, summary: `${playerId} Power Strikes (spends 2 Energy).` };
      }
      case 'celebrate':
        if (s.gameState.phase !== 'victory') {
          throw new GameError('ILLEGAL_MOVE', 'celebrate is only possible in the victory phase.');
        }
        return { newState: s, summary: `${playerId} celebrates.` };
    }
  },

  async getAIMove() {
    return { move: { type: 'advance' as const }, narration: 'The AI advances.' };
  },

  getRulesText(): string {
    return renderRulesText(STUB_SECTIONS);
  },
  getRulesSections(): RuleSection[] {
    return STUB_SECTIONS;
  },

  getCurrentPhase(state) {
    return state.gameState.phase;
  },

  describeMoveGates(state, playerId) {
    const energy = state.gameState.energy[playerId] ?? 0;
    return [
      { move_type: 'advance', status: 'available' },
      { move_type: 'rest', status: 'available' },
      energy >= 2
        ? { move_type: 'power_strike', status: 'available' }
        : {
            move_type: 'power_strike',
            status: 'gated',
            reason: `needs 2 Energy, you have ${energy}`,
            rules_section: 'power-strike',
          },
      state.gameState.phase === 'victory'
        ? { move_type: 'celebrate', status: 'available' }
        : {
            move_type: 'celebrate',
            status: 'routine',
            reason: 'only possible during the victory phase',
            rules_section: 'celebrating',
          },
    ];
  },
};

// A second stub with ONLY the blob — locks backward compat (no sections index,
// topic ignored).
export const blobOnlyStub: Game<StubState, StubMove> = {
  ...rulesTeachingStub,
  id: 'blob-only-stub',
  name: 'Blob Only Stub',
  getRulesText: () => 'One big blob of rules.',
  getRulesSections: undefined,
};
