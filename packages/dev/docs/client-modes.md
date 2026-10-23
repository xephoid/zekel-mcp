# Client modes, private input, physical setup

Design record for server changes made for zekel Live, a voice client. Its code
drives the turn loop itself: it follows `next_step`, calls `run_ai_turn`, and
reads each move's `state_summary` aloud. A language model there only interprets
what the player says. So the server needed to:

- (a) stop sending that client directions meant for a language model that runs
  the loop,
- (b) say when an answer must be entered privately,
- (c) give physical setup as ordered steps, and
- (d) produce `state_summary` strings that work spoken as-is (see
  [`spoken-narration.md`](./spoken-narration.md)).

Paths below are in zekel-mcp: `packages/mcp/src/…` for the server
(`@zekel/mcp`) and `packages/game-kit/src/…` for the kit (`@zekel/game-kit`).

## 1. Client mode, declared per connection

A client declares its mode once, in the MCP initialize request:

```json
{ "capabilities": { "experimental": { "zekel": { "mode": "orchestrated" } } } }
```

Anything else (including nothing) is **`llm_driven`**, the normal behaviour for
a chat client where a language model runs the loop. The mode is a capability
the client declares. It is never guessed from `clientInfo`, and never stored on
the game session: one session may be played from a voice client and later from
a chat client, and each gets text that fits it.

**Wiring** (`mcp/src/mcp/clientMode.ts`; `buildMcpServer` in
`mcp/src/server/bootstrap.ts`): each connection gets a context. The initialize
handler reads the declared mode into it and answers with the instructions for
that mode. (The SDK fixes `instructions` when the server is built, so the
handler reuses the SDK's own initialize reply and swaps that one field.) This
works the same over stdio and HTTP. Every tool and resource handler is wrapped
once at registration (`withClientMode`), so the split lives in one place.

**The split: facts vs directions for running the loop.** Orchestrated
connections get facts only:

| Kept (facts) | Dropped (loop directions) |
|---|---|
| `next_step.status`, `active_player_id`, `human_response`, `facts`, `seat`, `shared_session` | `next_step.instruction` |
| `state_summary`, `narration`, views, logs, `move_menu` entries | `report_to_human` |
| `rules_briefing` sections, the reasons on the list of unavailable moves (`unavailable_moves`) | `agent_guidance` (replaced by `session_context`, below) |
| `players_recorded`, `setup_checklist`, `physical_setup`, `join` codes/tokens | `naming_reminder`, `difficulty_reminder`, `all_ai_reminder`, `join.instructions`, `join_session`'s `instructions`, `recovery.hint`, `how_to_apply`, `unavailable_note`, `move_menu.how_to_use`, `rules_briefing.teach_note` |

- **Server instructions**: orchestrated connections get
  `ORCHESTRATED_SERVER_INSTRUCTIONS` (`mcp/src/mcp/serverInstructions.ts`) — the
  physical-first premise and where each fact lives, with no turn-loop protocol.
  A server built with `runServer` passes it as `orchestratedInstructions`
  (zekel-games' `examples/serve.mjs` shows this).
- **Session start**: `Game.getSessionContext(table)` returns `{ persona,
  rules_context }`; an orchestrated `create_session` returns it as
  `session_context`. A game without the hook gives orchestrated clients no
  guidance text — never its chat-client prose, which mixes in loop directions.
  Example: Fractured Fist (`packages/fractured-fist/src/index.ts` and
  `src/setup.ts` in zekel-games).
- **Remote seats**: the prose notes in `mcp/src/mcp/nextStep.ts`
  (`remoteSeatNote`, `sharedSessionNote`) become `next_step.seat.remote` (the
  acting seat is on its own joined device) and `next_step.shared_session`
  (another device may change the session at any time).

**llm_driven is unchanged**, proven against a recording of the old server.
Fixed, seeded conversations were recorded before any of this changed
(`mcp/src/mcp/__tests__/__fixtures__/llmDrivenBaseline.json`, played by
`baselineFlows.ts` on the test game in that folder);
`mcp/src/mcp/__tests__/clientMode.test.ts` replays them and requires an exact
match. To re-record on purpose, run it with `UPDATE_BASELINE=1` and review the
diff: it is the text models read. The new structured fields (`facts`, `seat`,
`shared_session`, `human_response.private`) are removed for llm_driven clients —
the prose already carries the same facts. What llm_driven clients DO see that
is new:

- `create_session.physical_setup` (sent in every mode; the one field the
  baseline test allows);
- `private_reveals` on `apply_move`, only when a game reveals a card privately;
- status `awaiting_private_input`, only with 2+ human seats (never in the
  baseline's solo and joined sessions);
- a `human_response` on steps that had none (see §5).

## 2. `awaiting_private_input`

A `next_step.status` for a human turn whose answer the other humans at the
table must not hear. It carries the same `active_player_id` and
`human_response` as a normal human turn.

**How a step is marked private: `human_response.private = true`.** A game says
it on the answer shape — the thing that is secret is the answer — and
`buildNextStep` (`withSessionFacts` in `mcp/src/mcp/nextStep.ts`) turns the step
into `awaiting_private_input` only when:

- the session has 2+ human seats,
- the acting seat is not claimed by a remote device (a joined seat already
  answers on its own screen), and
- the step is `human_to_move` with a private answer.

Solo sessions never see it. Games never set the status themselves.

Why this and not the other options:
- *Working it out from the zone categories in `types.ts`*: those are comments,
  not data, and a zone doesn't say which STEP is secret (reporting a hidden
  hand is; playing a card from it face up is not).
- *A flag on legal moves or menu entries*: privacy is about the answer the
  client must collect, which exists before any move is chosen; and some steps
  (a secret pick with many offered moves) would need every entry marked.
- *A per-game hook*: more surface for the same one bit of information.

**The common case needs no per-game code**: `reportHandNextStep`
(`game-kit/src/reportHand.ts`), the shared "report what you drew" helper, marks
its answer private, so every game that has a human report a private hand
through it gets the status for free.

**Example: Cybernoir 2127** (two humans, hidden information) marks the Hacker's
hideout pick, the new safehouse when burning, the Detective's hand report
during a burn, informant upkeep, and the Detective's main turn (a recruit names
a person who becomes a face-down informant) — see the `private: true` answers
in `packages/cybernoir-2127/src/index.ts` in zekel-games. Sweetlands Imperium
marks its secret answers the same way. The server side is locked end to end by
`mcp/src/mcp/__tests__/privateInput.test.ts`, on its test game: two humans on
one device → private in both modes; solo → `human_to_move`; the acting seat
joined from its own device → `human_to_move` with `seat.remote`.

**Consumers** treat it as a human turn through `isHumanTurnStatus`
(`game-kit/src/game.ts`): the server's `mcp/moveMenu.ts`, every `@zekel/dev`
harness bot (`assistantBot`, `desyncBot`, `engineBot`, `llmBot`, `relayBot`),
and the web debug page. Branch on `isHumanTurnStatus`, never on the literal
status.

**Revealed private information**: a card the server deals to one human goes in
`ApplyMoveResult.privateReveals`, which `apply_move` returns as
`private_reveals` to that seat only, so a client shows it instead of speaking
it. The summary never names it. Examples: Fractured Fist (a digital player's
draws) and Neither Guts nor Gears.

## 3. Physical setup as ordered steps

`Game.getPhysicalSetup(state)` returns `PhysicalSetupStep[]`, sent as
`create_session.physical_setup` in every mode. Real setups mix doing and
telling ("deal 5 cards" … "tell me what you drew"), so it is one ordered list
where each step is either:

- `{ kind: 'action', text }` — one physical action, short and speakable; or
- `{ kind: 'report', text, move_type }` — the players now tell the server
  something; `move_type` points at the `setup_checklist` entry
  (`getSetupChecklist`), which still owns the count and exactly what to ask.

Both may carry `for_player_id`. `setup_checklist` is unchanged.

Example: **Fractured Fist** (`packages/fractured-fist/src/setup.ts` in
zekel-games) — actions only, since nothing is reported at setup. A game that
does report things at setup (a colour choice, each human's starting hand) puts
those `report` steps in table order between the actions, and takes every number
from the session's state, never from memory.

## 4. Structured next_step facts

`NextStep.facts` (`NextStepFacts` in `game-kit/src/game.ts`) holds what a
client that never reads `instruction` still needs: `phase`, `turn_owner_id`,
`reason`, `progress`, `repeat`, `options`, `notes`. Plain game facts in
speakable words, with no tool names or loop directions — checked by
`lintNextStepFacts` (`game-kit/src/nextStepFacts.ts`). The move shape stays in
`human_response.records_as`.

## 5. The describeNextStep audit

A read-only audit went through every game's `describeNextStep` (the hook that
tells the model what comes next during setup and pending choices; see
[`building-a-game.md`](./building-a-game.md), "Telling the model what comes
next"). Then every fact that lived only in `instruction` prose was moved into
`facts` or `human_response`. What it found, across about two dozen games:

- About 125 of roughly 200 return paths held at least one fact only in prose.
- 47 human-to-move paths had no `human_response` at all.

Kinds of prose-only fact found, and where each now lives:

| Kind | Now in |
|---|---|
| Which move and fields (on paths with no answer hint) | `human_response.records_as` |
| The options to choose among | `facts.options` |
| Counts and progress ("step 1 of 2", "card 2 of 5") | `facts.progress`, `facts.notes` |
| "Repeat until" | `facts.repeat` |
| Thresholds, costs, consequences, limits | `facts.notes` |
| Whose turn it really is when another seat chooses | `facts.turn_owner_id` |
| Why the step is owed now | `facts.reason` |
| Role or phase name | `facts.phase` |
| Secrecy | `human_response.private` |

**How to lock a game's facts:** add a test that walks the game's
`describeNextStep` paths and runs `lintNextStepFacts` on each. Examples in
zekel-games: `packages/sweetlands-imperium/src/__tests__/nextStepFacts.test.ts`,
`packages/warble-way-galaxy/src/__tests__/nextStepFacts.test.ts`, and the facts
checks in `packages/fractured-fist/src/__tests__/setupAndPrivacy.test.ts`. The
shared helpers `setupChoiceNextStep` and `reportHandNextStep` already give
facts.

At the time of the audit, Neither Guts nor Gears was left for later (16 paths
with no answer hint), because other work was editing it. Games written after
the audit should give facts from the start.

**Status bugs the audit found and fixed** (each now has a test). These are
worth checking for in any game:
- A game sent `human_to_move` for choices that belonged to an AI seat (dice,
  position, effect, setup and deployment choices).
- A game's tie-break step did not check that the seat was human.
- A game's damage step checked the attacker's kind but asked the defender.

**Found, not fixed** (fixing would change what llm_driven clients see, or
needed a rules call). The general lessons:
- A shared helper's `records_as` wording ("cards by printed name") did not fit
  a game whose report takes card types instead.
- A step's `human_response` still offered an option that an active card had
  ruled out.
- A step's prose described a rule differently from what the engine did. The
  facts follow the engine; the prose was the bug.
- A setup report owed to a human while `next_step` still said the AI was to
  move (the code called the order deliberate; worth confirming in any game
  that does this).
- Several games' `instruction`/`ask` texts named seats by raw id instead of by
  display name.

## 6. Output schemas (typed results)

So typed clients can generate their types from the server instead of copying
them by hand, six tools publish an MCP `outputSchema` and return their result a
second time as `structuredContent`: `create_session`, `get_legal_moves`,
`apply_move`, `get_ai_move`, `run_ai_turn`, `get_state`. Schemas:
`mcp/src/mcp/outputSchemas.ts`.

- **The text block is untouched.** `structuredContent` is the text block's
  JSON, parsed after it has been shaped for the connection's mode
  (`withClientMode` adds it), so the two can never disagree and llm_driven
  clients get the same text as before (the baseline test still passes).
- **Fields one mode drops are optional** (`instruction`, `report_to_human`,
  `agent_guidance`, the reminders, `how_to_use`, `teach_note` for orchestrated;
  `facts`, `seat`, `shared_session`, `human_response.private` for llm_driven).
  Each says in its description which mode gets it.
- **One source, checked by the compiler.** The TypeScript types in
  `game-kit/src/game.ts` stay what game code is written against. The bottom of
  `outputSchemas.ts` makes the typecheck fail if a type gains a field the
  schema lacks, or if a value of the type would not fit the schema.
- **Published open** (extra fields allowed), because both ends check: the SDK
  server checks each result against the schema before sending, and an SDK
  client that has listed the tools checks what it receives. An open schema
  means a new field can't turn a working call into an error. The test checks
  real responses against a closed copy, so a field that is sent but not
  described fails there instead. A field with the WRONG type still fails the
  call — that is the contract working.
- **For code generation**: in zekel-mcp, `pnpm schemas` writes
  `packages/mcp/schemas/tool-outputs.schema.json` (draft-07, with shared types
  under `definitions`: `NextStep`, `HumanResponse`, `MoveMenu`, …). The file
  ships in the `@zekel/mcp` package. `mcp/src/mcp/__tests__/outputSchemas.test.ts`
  fails when it is out of date, and plays the test game in both modes (humans
  against the AI, two humans, and all-AI), checking every result.

**When you change a field** in one of these results (this is a change to
`@zekel/mcp`, made in zekel-mcp): add it to the schema (optional if a mode
drops it), run `pnpm schemas`, and commit the JSON.
