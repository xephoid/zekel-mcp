// Lucky Tic-Tac-Toe: a made-up game that exists only to test the server.
//
// It is tic-tac-toe with three small twists, each there because a server
// feature needs a game that has it:
//   1. Players choose X or O at setup, humans first (setup choices).
//   2. Each player holds a secret lucky-square card (hidden information):
//      - a human at a physical table draws one from the real deck and REPORTS
//        it privately (a reported value, a private answer);
//      - a human playing on screen is DEALT one by the server, revealed only
//        to them (private_reveals);
//      - an AI is dealt one by the server from what is left.
//   3. If the board fills with no three-in-a-row, whoever has their own mark
//      on their own lucky square wins (both or neither: a draw).
// It also carries a rich game log, a scoreboard, rules sections, physical
// setup steps, one question it answers (query_choice "lucky_square") and a
// balance declaration. Its AI never uses randomness, so recorded
// conversations replay identically.
//
// Like any game, it imports only @zekel/game-kit.

import {
  GameError,
  defaultSetupAssignment,
  pushLogEntry,
  renderLogEntries,
  renderRulesText,
  setupChoiceChecklistStep,
  setupChoiceNextStep,
  shuffle,
  randomSeed,
  seatDisplayName,
  validateSetupSelections,
  type BalanceAxis,
  type Game,
  type GameLogEntry,
  type GameResult,
  type LegalMove,
  type NextStep,
  type PhysicalSetupStep,
  type PlayerConfig,
  type PrivateReveal,
  type ReportVoice,
  type RuleSection,
  type SessionState,
  type SetupChoiceSpec,
  type SetupStep,
} from '@zekel/game-kit';

export const SQUARES = ['A1', 'B1', 'C1', 'A2', 'B2', 'C2', 'A3', 'B3', 'C3'] as const;
type Mark = 'X' | 'O';
const LINES = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6],
];

export interface LuckyState {
  phase: 'choose_marks' | 'lucky_cards' | 'play' | 'over';
  marks: Record<string, Mark>;
  board: Array<Mark | null>;
  /** The server's shuffled deck, used to deal on-screen humans and AI seats. */
  deck: string[];
  /** Each seat's secret lucky square, once it has one. */
  lucky: Record<string, string>;
  /** 'draw' when the game ended level. */
  winner: string | null;
  log: GameLogEntry[];
}

export type LuckyMove =
  | { type: 'assign_setup_choices'; selections: Record<string, string> }
  | { type: 'report_lucky_card'; square: string }
  | { type: 'draw_lucky_card' }
  | { type: 'place'; square: string };

type S = SessionState<LuckyState>;

function markSpec(players: PlayerConfig[]): SetupChoiceSpec {
  return {
    choiceLabel: 'mark',
    options: [
      { id: 'X', label: 'X (moves first)' },
      { id: 'O', label: 'O' },
    ],
    seats: players,
    distinct: true,
  };
}

/** How a seat is named in text: the name a person gave, else the seat's mark
 *  once it has one ("the O player"), else the kit's default ("the AI"). */
function nameOf(state: S, playerId: string): string {
  const given = state.players.find((p) => p.player_id === playerId)?.name?.trim();
  if (given && given !== playerId) return given;
  const mark = state.gameState.marks[playerId];
  return mark ? `the ${mark} player` : seatDisplayName(state.players, playerId);
}

/** A name at the start of a sentence. */
function NameOf(state: S, playerId: string): string {
  const n = nameOf(state, playerId);
  return n.charAt(0).toUpperCase() + n.slice(1);
}

function resolveSquare(raw: unknown): string {
  const square = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!(SQUARES as readonly string[]).includes(square)) {
    throw new GameError('ILLEGAL_MOVE', `"${String(raw)}" is not a square. Squares are named A1 to C3 (column letter, then row).`);
  }
  return square;
}

/** The seat that owes a lucky card next: the first human (in seat order) without one. */
function luckyOwedBy(state: S): PlayerConfig | null {
  if (state.gameState.phase !== 'lucky_cards') return null;
  return state.players.find((p) => p.kind === 'human' && !state.gameState.lucky[p.player_id]) ?? null;
}

const isDigital = (p: PlayerConfig): boolean => p.table === 'digital';

function lineWinner(board: Array<Mark | null>): Mark | null {
  for (const [a, b, c] of LINES) {
    const m = board[a!];
    if (m && m === board[b!] && m === board[c!]) return m;
  }
  return null;
}

function clone(state: S): S {
  return {
    ...state,
    gameState: {
      ...state.gameState,
      marks: { ...state.gameState.marks },
      board: [...state.gameState.board],
      deck: [...state.gameState.deck],
      lucky: { ...state.gameState.lucky },
      log: [...state.gameState.log],
    },
  };
}

/** Deal every AI seat a lucky card from what is left, then start play. */
function dealAiCardsAndStart(next: S): void {
  const g = next.gameState;
  for (const p of next.players) {
    if (p.kind === 'ai' && !g.lucky[p.player_id]) {
      const square = g.deck.find((sq) => !Object.values(g.lucky).includes(sq))!;
      g.deck = g.deck.filter((sq) => sq !== square);
      g.lucky[p.player_id] = square;
      pushLogEntry(g.log, { turn: next.turnNumber, actor: p.player_id, category: 'setup', summary: `${NameOf(next, p.player_id)} was dealt a lucky-square card (kept secret).` });
    }
  }
  g.phase = 'play';
  next.activePlayerId = Object.entries(g.marks).find(([, m]) => m === 'X')![0];
  pushLogEntry(g.log, { turn: next.turnNumber, actor: null, category: 'phase', summary: `Play begins. ${NameOf(next, next.activePlayerId)} (X) moves first.` });
}

/** Ends the game if it is over; says whether it did. */
function finishIfOver(next: S): boolean {
  const g = next.gameState;
  const line = lineWinner(g.board);
  if (line) {
    g.winner = Object.entries(g.marks).find(([, m]) => m === line)![0];
  } else if (g.board.every((c) => c !== null)) {
    const holders = next.players
      .map((p) => p.player_id)
      .filter((pid) => g.board[SQUARES.indexOf(g.lucky[pid] as (typeof SQUARES)[number])] === g.marks[pid]);
    g.winner = holders.length === 1 ? holders[0]! : 'draw';
  } else {
    return false;
  }
  g.phase = 'over';
  const reveal = next.players.map((p) => `${NameOf(next, p.player_id)}'s lucky square was ${g.lucky[p.player_id]}`).join('; ');
  pushLogEntry(g.log, {
    turn: next.turnNumber,
    actor: null,
    category: 'phase',
    summary: `Game over: ${g.winner === 'draw' ? 'a draw' : `${nameOf(next, g.winner!)} wins`}. ${reveal}.`,
  });
  return true;
}

const RULES: RuleSection[] = [
  {
    id: 'setup',
    title: 'Setup',
    text: 'Each player chooses a mark, X or O; X moves first. Shuffle the nine lucky-square cards (A1 to C3). Each player draws one in secret.',
    tags: { move_types: ['assign_setup_choices', 'report_lucky_card', 'draw_lucky_card'], phases: ['Setup'] },
  },
  {
    id: 'placing',
    title: 'Placing a mark',
    text: 'On your turn, put your mark on any empty square. Squares are named by column (A to C) and row (1 to 3).',
    tags: { move_types: ['place'], phases: ['Play'] },
  },
  {
    id: 'winning',
    title: 'Winning',
    text: 'Three of your marks in a row, column or diagonal wins. If the board fills first, reveal the lucky cards: a player whose own mark is on their own lucky square wins. If both or neither do, the game is a draw.',
    tags: { phases: ['Play'] },
  },
];

const BALANCE_AXES: BalanceAxis[] = [
  {
    name: 'mark',
    kind: 'cosmetic',
    description: 'Which player is X (X moves first).',
    levers: [],
    recipe: 'Swap the marks between seats and compare win rates.',
  },
];

export interface LuckyOptions {
  seed?: number;
}

export interface MakeOptions {
  id?: string;
  /** Leave out the query_choice question, for a game that answers none. */
  withoutQuery?: boolean;
  /** A voice profile of its own, overriding the server's default. */
  reportVoice?: ReportVoice;
}

export function makeLuckyTicTacToe(make: MakeOptions = {}): Game<LuckyState, LuckyMove, LuckyOptions> {
  const id = make.id ?? 'lucky-tic-tac-toe';

  const game: Game<LuckyState, LuckyMove, LuckyOptions> = {
    id,
    name: 'Lucky Tic-Tac-Toe',
    description: 'Tic-tac-toe with a secret lucky square for each player. A made-up game for testing the server.',
    minPlayers: 2,
    maxPlayers: 2,
    supportsAI: true,
    hasHiddenInformation: true,
    optionsSchema: { type: 'object', properties: { seed: { type: 'integer' } } },
    moveSchema: {
      oneOf: [
        { type: 'object', properties: { type: { const: 'assign_setup_choices' }, selections: { type: 'object' } }, required: ['type', 'selections'] },
        { type: 'object', properties: { type: { const: 'report_lucky_card' }, square: { type: 'string' } }, required: ['type', 'square'] },
        { type: 'object', properties: { type: { const: 'draw_lucky_card' } }, required: ['type'] },
        { type: 'object', properties: { type: { const: 'place' }, square: { type: 'string' } }, required: ['type', 'square'] },
      ],
    },
    version: '1.0.0',
    ...(make.reportVoice ? { reportVoice: make.reportVoice } : {}),

    createSession(players, options) {
      const { items: deck } = shuffle(SQUARES, options?.seed ?? randomSeed());
      const state: S = {
        sessionId: '',
        gameId: id,
        players,
        activePlayerId: players[0]!.player_id,
        turnNumber: 1,
        gameState: { phase: 'choose_marks', marks: {}, board: Array(9).fill(null), deck, lucky: {}, winner: null, log: [] },
        moveLog: [],
        createdAt: new Date().toISOString(),
      };
      const reporter = players.find((p) => p.kind === 'human');
      if (reporter) {
        state.activePlayerId = reporter.player_id;
      } else {
        // All AI: no one to ask, so marks go by seat order and cards are dealt now.
        state.gameState.marks = defaultSetupAssignment(markSpec(players)) as Record<string, Mark>;
        state.gameState.phase = 'lucky_cards';
        dealAiCardsAndStart(state);
      }
      return state;
    },

    getLegalMoves(state, playerId) {
      const g = state.gameState;
      if (g.phase === 'choose_marks') {
        if (playerId !== state.activePlayerId) return [];
        const selections = defaultSetupAssignment(markSpec(state.players));
        return [{ move_id: 'marks-default', description: `Assign marks: ${Object.entries(selections).map(([p, m]) => `${nameOf(state, p)} ${m}`).join(', ')}`, move: { type: 'assign_setup_choices', selections } }];
      }
      if (g.phase === 'lucky_cards') {
        const owed = luckyOwedBy(state);
        if (!owed || owed.player_id !== playerId) return [];
        if (isDigital(owed)) return [{ move_id: 'draw', description: 'Draw your lucky-square card', move: { type: 'draw_lucky_card' } }];
        return SQUARES.map((sq) => ({ move_id: `lucky-${sq}`, description: `I drew the ${sq} card`, move: { type: 'report_lucky_card', square: sq } }));
      }
      if (g.phase === 'play' && playerId === state.activePlayerId) {
        return SQUARES.filter((_, i) => g.board[i] === null).map((sq) => ({ move_id: `place-${sq}`, description: `Put ${g.marks[playerId]} on ${sq}`, move: { type: 'place', square: sq } }));
      }
      return [];
    },

    getPublicView(state) {
      const g = state.gameState;
      const rows = [1, 2, 3].map((r) => ['A', 'B', 'C'].map((c) => g.board[SQUARES.indexOf(`${c}${r}` as (typeof SQUARES)[number])] ?? '.').join(' '));
      return {
        phase: g.phase,
        marks: g.marks,
        board: Object.fromEntries(SQUARES.map((sq, i) => [sq, g.board[i]])),
        picture: rows,
        // Lucky squares are secret until the game ends.
        lucky_squares: g.phase === 'over' ? g.lucky : Object.fromEntries(Object.keys(g.lucky).map((p) => [p, 'hidden'])),
        winner: g.winner,
      };
    },

    getPlayerView(state, playerId) {
      const view = game.getPublicView(state) as Record<string, unknown>;
      const mine = state.gameState.lucky[playerId];
      return { ...view, your_lucky_square: mine ?? null };
    },

    isGameOver(state): GameResult | null {
      const g = state.gameState;
      if (g.phase !== 'over') return null;
      const winners = g.winner && g.winner !== 'draw' ? [g.winner] : [];
      return {
        game_over: true,
        winners,
        scores: Object.fromEntries(state.players.map((p) => [p.player_id, winners.includes(p.player_id) ? 1 : 0])),
        summary: winners.length ? `${nameOf(state, winners[0]!)} wins.` : 'The game is a draw.',
      };
    },

    applyMove(state, playerId, move) {
      const next = clone(state);
      const g = next.gameState;
      const cursor = g.log.length;
      const privateReveals: PrivateReveal[] = [];
      const type = (move as { type?: string })?.type;

      if (g.phase === 'over') throw new GameError('GAME_OVER', 'The game is over.');

      if (type === 'assign_setup_choices' && g.phase === 'choose_marks') {
        const spec = markSpec(next.players);
        validateSetupSelections(spec, (move as { selections: Record<string, string> }).selections ?? {}, next.activePlayerId, playerId);
        g.marks = { ...(move as { selections: Record<string, string> }).selections } as Record<string, Mark>;
        g.phase = 'lucky_cards';
        pushLogEntry(g.log, { turn: next.turnNumber, actor: playerId, category: 'setup', summary: `${next.players.map((p) => `${seatDisplayName(next.players, p.player_id)} plays ${g.marks[p.player_id]}`).join('; ')}.`.replace(/^./, (c) => c.toUpperCase()) });
        const owed = luckyOwedBy(next);
        if (owed) next.activePlayerId = owed.player_id;
        else dealAiCardsAndStart(next);
      } else if ((type === 'report_lucky_card' || type === 'draw_lucky_card') && g.phase === 'lucky_cards') {
        const owed = luckyOwedBy(next);
        if (!owed || owed.player_id !== playerId) throw new GameError('NOT_YOUR_TURN', 'It is not your turn to take a lucky card.');
        let square: string;
        if (type === 'draw_lucky_card') {
          if (!isDigital(owed)) throw new GameError('ILLEGAL_MOVE', 'You draw from the physical deck at the table: report the card with report_lucky_card.');
          square = g.deck.find((sq) => !Object.values(g.lucky).includes(sq))!;
          privateReveals.push({ player_id: playerId, text: `Your lucky square is ${square}.` });
        } else {
          if (isDigital(owed)) throw new GameError('ILLEGAL_MOVE', 'The server deals your card on screen: use draw_lucky_card.');
          square = resolveSquare((move as { square?: unknown }).square);
          if (Object.values(g.lucky).includes(square)) throw new GameError('ILLEGAL_MOVE', `The ${square} card was already drawn; check the card you hold.`);
        }
        g.lucky[playerId] = square;
        g.deck = g.deck.filter((sq) => sq !== square);
        pushLogEntry(g.log, { turn: next.turnNumber, actor: playerId, category: 'setup', summary: `${NameOf(next, playerId)} took a lucky-square card (kept secret).` });
        const after = luckyOwedBy(next);
        if (after) next.activePlayerId = after.player_id;
        else dealAiCardsAndStart(next);
      } else if (type === 'place' && g.phase === 'play') {
        if (playerId !== next.activePlayerId) throw new GameError('NOT_YOUR_TURN', `It is ${nameOf(next, next.activePlayerId)}'s turn.`);
        const square = resolveSquare((move as { square?: unknown }).square);
        const index = SQUARES.indexOf(square as (typeof SQUARES)[number]);
        if (g.board[index] !== null) throw new GameError('ILLEGAL_MOVE', `${square} is already taken.`);
        g.board[index] = g.marks[playerId]!;
        pushLogEntry(g.log, { turn: next.turnNumber, actor: playerId, category: 'action', summary: `${NameOf(next, playerId)} puts ${g.marks[playerId]} on ${square}.`, gained: [{ resource: 'marks placed', amount: 1 }] });
        if (!finishIfOver(next)) {
          next.activePlayerId = next.players.find((p) => p.player_id !== playerId)!.player_id;
          next.turnNumber += 1;
        }
      } else {
        throw new GameError('ILLEGAL_MOVE', `A ${String(type)} move is not possible now (phase: ${g.phase}).`);
      }

      return {
        newState: next,
        summary: renderLogEntries(g.log.slice(cursor)),
        ...(privateReveals.length ? { privateReveals } : {}),
      };
    },

    async getAIMove(state, playerId) {
      const legal = game.getLegalMoves(state, playerId);
      if (legal.length === 0) throw new GameError('NOT_YOUR_TURN', `${playerId} has nothing to do now.`);
      const g = state.gameState;
      if (g.phase !== 'play') return { move: legal[0]!.move, narration: legal[0]!.description };
      // Win, else block, else own lucky square, else centre, else the first free square.
      const mine = g.marks[playerId]!;
      const theirs: Mark = mine === 'X' ? 'O' : 'X';
      const completes = (mark: Mark) =>
        legal.find((m) => {
          const board = [...g.board];
          board[SQUARES.indexOf((m.move as { square: string }).square as (typeof SQUARES)[number])] = mark;
          return lineWinner(board) === mark;
        });
      const pick =
        completes(mine) ??
        completes(theirs) ??
        legal.find((m) => (m.move as { square: string }).square === g.lucky[playerId]) ??
        legal.find((m) => (m.move as { square: string }).square === 'B2') ??
        legal[0]!;
      return { move: pick.move, narration: pick.description };
    },

    getRulesSections: () => RULES,
    getRulesText: () => renderRulesText(RULES),
    getCurrentPhase: (state) => (state.gameState.phase === 'play' || state.gameState.phase === 'over' ? 'Play' : 'Setup'),
    getSessionStartGuidance: () =>
      'Lucky Tic-Tac-Toe. Setup: players choose X or O (humans first), then each takes a secret lucky-square card. ' +
      'Each turn is exactly one move: put your mark on one empty square. Follow next_step.',
    getLog: (state) => state.gameState.log,
    getScoreboard: (state) =>
      Object.fromEntries(
        state.players.map((p) => [p.player_id, { marks_placed: state.gameState.board.filter((c) => c && c === state.gameState.marks[p.player_id]).length }]),
      ),
    getBalanceAxes: () => BALANCE_AXES,

    getSetupChecklist(state): SetupStep[] {
      const steps: SetupStep[] = [];
      if (state.gameState.phase === 'choose_marks') {
        const step = setupChoiceChecklistStep('assign_setup_choices', markSpec(state.players));
        if (step) steps.push(step);
      }
      const physicalHumans = state.players.filter((p) => p.kind === 'human' && !isDigital(p) && !state.gameState.lucky[p.player_id]);
      if (physicalHumans.length && state.gameState.phase !== 'play' && state.gameState.phase !== 'over') {
        steps.push({
          move_type: 'report_lucky_card',
          count: physicalHumans.length,
          description: 'Each human at the table draws one lucky-square card in secret and reports it privately.',
          ask_human_for: 'which lucky-square card they drew (A1 to C3)',
        });
      }
      return steps;
    },

    getPhysicalSetup(state): PhysicalSetupStep[] {
      const steps: PhysicalSetupStep[] = [{ kind: 'action', text: 'Shuffle the nine lucky-square cards (A1 to C3) and put them face down.' }];
      for (const p of state.players) {
        if (p.kind === 'human' && !isDigital(p)) {
          steps.push({ kind: 'report', text: 'Draw one lucky-square card and keep it secret.', move_type: 'report_lucky_card', for_player_id: p.player_id });
        }
      }
      return steps;
    },

    describeNextStep(state): NextStep | null {
      const g = state.gameState;
      if (g.phase === 'choose_marks') return setupChoiceNextStep('assign_setup_choices', markSpec(state.players), state.activePlayerId);
      const owed = luckyOwedBy(state);
      if (!owed) return null;
      if (isDigital(owed)) {
        return {
          status: 'human_to_move',
          active_player_id: owed.player_id,
          instruction: `${NameOf(state, owed.player_id)} draws a lucky-square card on screen: apply draw_lucky_card.`,
          human_response: { ask: 'Ready to draw your lucky-square card?', example: 'Draw it', records_as: 'draw_lucky_card' },
          facts: { phase: 'Setup', reason: 'Each player takes a secret lucky-square card before play.' },
        };
      }
      return {
        status: 'human_to_move',
        active_player_id: owed.player_id,
        instruction: `ASK ${nameOf(state, owed.player_id)} which lucky-square card they drew (A1 to C3) and record it with report_lucky_card. Do NOT invent it.`,
        human_response: {
          ask: 'Which lucky-square card did you draw?',
          example: 'B2',
          records_as: 'report_lucky_card with square: the card drawn (A1 to C3)',
          private: true,
        },
        facts: { phase: 'Setup', reason: 'Each player takes a secret lucky-square card before play.', options: [...SQUARES] },
      };
    },
  };

  if (!make.withoutQuery) {
    game.queryChoice = (state, playerId, name) => {
      if (name !== 'lucky_square') throw new GameError('ILLEGAL_MOVE', `Lucky Tic-Tac-Toe answers one question: lucky_square (not "${name}").`);
      const square = state.gameState.lucky[playerId];
      if (!square) throw new GameError('ILLEGAL_MOVE', 'You have no lucky square yet.');
      return { your_lucky_square: square };
    };
  }

  return game;
}

/** The standard copy, registered by the test server. */
export const luckyTicTacToe = makeLuckyTicTacToe();
