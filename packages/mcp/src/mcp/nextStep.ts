import type { Game, GameResult, NextStep, SessionState } from '@zekel/game-kit';

// NextStep now lives in core/game.ts (so game modules can build one in their
// describeNextStep hook without depending on the mcp layer). Re-exported here
// for the existing import sites.
export type { NextStep } from '@zekel/game-kit';

// Builds an explicit, machine-followable directive for what the client should
// do given a session's current state. Emitted in every apply_move /
// get_ai_move response AND in get_state / the session-player resource, so a
// model never has to reconstruct the turn loop from the prose system prompt or
// from memory — it can re-derive "whose turn is it, what is the server waiting
// for" from authoritative state at any time by reading this one field.
//
// The load-bearing case is consecutive AI moves: one get_ai_move applies a
// single move, but an AI *turn* is usually several moves, so the client must
// keep calling get_ai_move until the active player flips. Weaker models
// under-call here (stop after one AI move, often after narrating) and stall
// the game; the ai_to_move instruction says "keep calling" explicitly and
// tells the model that checking state again will confirm whether it is done.
//
// This is game-agnostic — it reads only the player kind and active player off
// the session, so every registered game gets it for free.
// Dual-addressed directive for a REMOTE (joined) seat: the host reads it as
// "stand down and wait", the remote player reads it as "your turn". Both clients
// share the one session, so the seat's claim_token is what actually enforces the
// split; this just keeps the host from polling/acting blindly.
function remoteSeatNote(state: SessionState<unknown>, seatId: string): string {
  const name = state.players.find((p) => p.player_id === seatId)?.name ?? seatId;
  return (
    `It is ${name}'s turn — a REMOTE player on their own device (seat ${seatId}). ` +
    'IF YOU ARE THE HOST: you cannot act for this seat (it is locked to them with their ' +
    'claim_token), so do NOT call get_legal_moves, apply_move, get_ai_move or run_ai_turn ' +
    `for it. WAIT until ${name} tells you they have finished, then say "next" — re-call ` +
    `get_state to see whose turn it is and continue. IF YOU ARE ${name} (the remote player): ` +
    'act on your seat using your auth_token (your claim_token).'
  );
}

// Appended to every OTHER directive (AI's turn, or the host's own turn) once a
// remote seat has actually been claimed — i.e. a second device is genuinely in
// play, not just provisioned. Without this, a client only ever gets told "you
// are not the sole authority" at the moment it's literally the remote seat's
// turn; the rest of the time it reads a directive that says nothing about a
// second device and defaults to treating itself as the only actor — e.g. the
// remote client checking in during the AI's or the host's turn has no reason
// to believe anything could have happened without ITS involvement, so it
// answers from what it last saw instead of re-checking. This note is harmless
// for the host (who is meant to keep driving) and load-bearing for a second
// client polling in: it says explicitly not to act and to re-fetch state
// rather than trust memory.
function sharedSessionNote(state: SessionState<unknown>): string {
  return (
    ' NOTE: this session is shared with a REMOTE player on a separate device ' +
    '(seatClaims present) — if you are not that seat and this is not naming an ' +
    'action for you to take, do not act; the other device applies its own moves ' +
    'directly to the shared session, invisibly to you, whenever it wants. Never ' +
    'assume the state you last saw is still current — call get_state to refresh ' +
    'it before reporting anything to your human or deciding what happens next.'
  );
}

// Facts a client needs about the session's devices and privacy, applied to
// every directive (game-supplied or generic):
// - a private human step becomes 'awaiting_private_input' only when 2+ humans
//   share the session AND the acting seat is not on its own joined device (a
//   joined seat already answers on its own screen). Solo sessions never see it.
// - `seat.remote` / `shared_session` state as data what the prose remote-seat
//   notes say (orchestrated clients never receive the prose).
function withSessionFacts(state: SessionState<unknown>, step: NextStep): NextStep {
  const claims = state.seatClaims ?? {};
  const out: NextStep = { ...step };
  const active = step.active_player_id;
  const activeClaimed = active !== null && claims[active] !== undefined;
  if (
    step.status === 'human_to_move' &&
    step.human_response?.private === true &&
    state.players.filter((p) => p.kind === 'human').length >= 2 &&
    !activeClaimed
  ) {
    out.status = 'awaiting_private_input';
  }
  if (Object.keys(claims).length > 0) {
    out.shared_session = true;
    if (active !== null) out.seat = { remote: activeClaimed };
  }
  return out;
}

export function buildNextStep(
  state: SessionState<unknown>,
  gameOver: GameResult | null,
  game?: Pick<Game<unknown, unknown, unknown>, 'describeNextStep'>,
): NextStep {
  return withSessionFacts(state, buildNextStepProse(state, gameOver, game));
}

function buildNextStepProse(
  state: SessionState<unknown>,
  gameOver: GameResult | null,
  game?: Pick<Game<unknown, unknown, unknown>, 'describeNextStep'>,
): NextStep {
  if (gameOver !== null) {
    return {
      status: 'game_over',
      active_player_id: null,
      instruction:
        'Game over. Narrate the result with color; do NOT call any more move tools.',
    };
  }
  // Let the game override the directive for phases the generic kind-based logic
  // can't see (setup-card reports, Court refills, battle-roll reports, etc.).
  // This is where weak models improvise and fabricate values; a precise
  // directive keeps them on the same rails the rest of the turn loop runs on.
  const custom = game?.describeNextStep?.(state);
  if (custom) {
    // If a game's phase-aware directive points at a REMOTE (joined) seat, the
    // host still must not act for it — wrap the directive with the wait note so
    // setup/report phases owed to a remote player route correctly too.
    if (
      custom.status === 'human_to_move' &&
      custom.active_player_id !== null &&
      state.seatClaims?.[custom.active_player_id] !== undefined
    ) {
      return { ...custom, instruction: remoteSeatNote(state, custom.active_player_id) + ' ' + custom.instruction };
    }
    // Otherwise the phase-aware directive is owed to the AI or to the host's
    // own seat, but a remote seat may still be claimed elsewhere in this
    // session — append the same "don't assume, re-check" note as the generic
    // branches below.
    if (Object.keys(state.seatClaims ?? {}).length > 0) {
      return { ...custom, instruction: custom.instruction + sharedSessionNote(state) };
    }
    return custom;
  }
  const activeId = state.activePlayerId;
  const active = state.players.find((p) => p.player_id === activeId);
  // A remote seat is genuinely in play (someone has actually claimed it, not
  // just been offered a join_code) — see sharedSessionNote for why this gets
  // appended even to directives that have nothing to do with that seat.
  const hasClaimedRemote = Object.keys(state.seatClaims ?? {}).length > 0;
  if (active?.kind === 'ai') {
    return {
      status: 'ai_to_move',
      active_player_id: activeId,
      instruction:
        `It is ${activeId}'s turn (AI player). EASIEST: call run_ai_turn for ${activeId} — ` +
        'it plays the AI through its entire turn (and any following AI turns) in ONE call ' +
        'and hands back a summary to report, stopping when a human must act or the game ' +
        'ends. Otherwise call get_ai_move, but note it applies exactly ONE move and an AI ' +
        `turn is usually several moves, so you must keep calling get_ai_move for ${activeId} ` +
        'until next_step reports a human is up or the game is over (reporting a move does ' +
        "NOT end the AI's turn). Either way, do NOT call apply_move for an AI (the server " +
        'applies AI moves itself). When you report, relay EVERY move\'s state_summary in ' +
        'order and in full — the human updates the physical board from those facts.' +
        (hasClaimedRemote ? sharedSessionNote(state) : ''),
    };
  }
  // Remote (joined) seat: it is owned by a second human on their OWN device, so
  // the host must NOT drive it. Emit a dual-addressed directive — the host reads
  // it as "wait", the remote player reads it as "your turn". The two clients
  // share this one session over the same server, so the seat's claim_token is
  // what actually enforces the split; this instruction tells the host to stand
  // down without polling blindly.
  if (active?.kind === 'human' && state.seatClaims?.[activeId] !== undefined) {
    return {
      status: 'human_to_move',
      active_player_id: activeId,
      instruction: remoteSeatNote(state, activeId),
    };
  }
  return {
    status: 'human_to_move',
    active_player_id: activeId,
    instruction:
      `It is ${activeId}'s turn (human player). Stop here and wait for them to ` +
      'declare what they played on the physical table, then relay that move with ' +
      'apply_move. Do not act on their behalf or guess their move.' +
      (hasClaimedRemote ? sharedSessionNote(state) : ''),
  };
}
