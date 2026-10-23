# Board drawing — design record

The web debug page can draw a game's table, built from a shared library of
`zekel-*` components. This is the third design tried; the first two were
dropped. The library, the gallery, the board host and a reference drawing
module (Sweetlands Imperium's) all exist today. Read "How we got here" before
assuming anything about the earlier designs.

## The goal

Open a browser, play a game against the AI, and SEE the board — drawn well
enough to look roughly like the physical game — so implementations can be
checked quickly with no language model in the loop. On top of that sits an
experiment: a model that can see images works out each game's look (layout,
colors) from the rulebook's photos, so this scales across many games without
drawing each one by hand. Experimental; it does not need to be perfect.

## Architecture

```
get_state view  →  per-game drawing module  →  zekel-* component library
(complete, per       (the game's src/viz/       (@zekel/mcp web/components/
 post-port §1a)       board.ts)                   + the gallery)
                     + colors (CSS vars) + layout
```

- **Component library** — custom elements with the `zekel-` prefix, one file per
  component in `@zekel/mcp`'s `web/components/` (`packages/mcp/src/web/components/`
  in zekel-mcp). TypeScript, compiled by the normal build, served as native ES
  modules by the HTTP server — no bundler. **HTML/CSS only — no SVG in the
  library.** Interactive: components send events ("card X clicked", "node Y
  clicked") that the debug page matches against legal moves to prefill the move
  builder. The catalog is the set of zone types checked against many games:
  `zekel-card`, `zekel-card-zone` (row/fan/pile), `zekel-tableau`,
  `zekel-bag`, `zekel-track` (linear/cyclic), `zekel-pool`, `zekel-grid`,
  `zekel-map` (nodes at percent positions; lines between nodes are left out on
  purpose until a game needs them).
- **Gallery** (`GET /gallery`) — a page showing every component with sample
  data. Three jobs: the review page for the library, the reference anyone
  mapping a game is pointed at, and the place breakage shows up. It was built
  FIRST, before any game work.
- **Per-game drawing module** — a small browser-side module that maps the
  game's view fields to component instances. It reads the ordinary `get_state`
  view: post-port §1a made views complete enough to draw from and filtered for
  privacy, so no in-between format is needed. Reference:
  `packages/sweetlands-imperium/src/viz/board.ts` in zekel-games.
- **Colors and layout per game** — CSS custom properties for colors; the page
  arrangement in CSS (grid-template-areas is a text picture of the layout and
  cannot overlap; flex is fine too). These are the only parts that need
  someone to look at the printed game.
- **Custom components** — when no library component fits, the game gets its
  own in its `src/components/`, justified in one sentence. A component moves
  into the shared library only when a second game wants it, which keeps the
  library small and chosen.
- **No tests of the components themselves** — the gallery plus eyes; tests get
  added when something actually breaks. The one mechanical check is the
  coverage check in [`viz-runbook.md`](./viz-runbook.md): every field the view
  serves is either drawn or declared as left out.

## The gate

**[`viz-runbook.md`](./viz-runbook.md)** — one gate, optional per game, after
post-port. View walk → component map → custom components → layout and colors →
an independent second look at the board photo → mechanical checks → a person's
verdict on the LIVE board. Record: `VIZ-NOTES.md` in the game's package folder,
written during the work.

It was two gates (planning the drawing, then building it) for a short while.
The split was justified by a limit of whoever would do the build — that every
visual decision had to be made in advance — which is a fact about the people
or tools available, not about the work. Its cost was real: it put the review of
*looks* on a prose document instead of on a screen, and turned a wrong color
into a "design change" that had to go back through a sign-off. The two were
merged. Coverage — the one thing the planning gate was really for — can be
counted exactly, so it belongs to a check, not to a person reading two lists.

## What exists

- The component library and the gallery (`GET /gallery`).
- The board host: the debug page loads `/web/games/<id>/viz/board.js` when a
  game names its folder with `webAssetsDir`, and draws the live board after
  every refresh. The library is loaded by the host first. Contract:
  `packages/mcp/src/web/host.ts` in zekel-mcp, and `GameBoardModule` in
  `@zekel/game-kit`'s `board.ts`.
- The **web debug page** (`/debug`, `packages/mcp/src/server/debugPage.ts`):
  an MCP JSON-RPC client in the browser, `move_menu` buttons, a move builder
  driven by the move schema, `run_ai_turn` and undo.
- **View completeness** (post-port §1a and
  [`view-completeness-audit.md`](./view-completeness-audit.md)) — the
  prerequisite that makes drawing straight from views possible.

## How we got here

Three designs in two days. Only the third is in the code, so here is the order
and why each was dropped.

**1. A separate scene format.** Games had an optional `describeScene(state,
viewer)` hook that returned a checked scene tree; a generic SVG renderer in the
debug page drew it; a `get_scene` MCP tool served it. It was designed while the
view-completeness audit was still running, before its results were in — so it
assumed views could not be drawn from and invented a second format for drawing.
Once §1a made the views complete and privacy-filtered, the scene tree was a
second description of the same facts, kept up per game, that could quietly
drift from the first. Dropped: the drawing module reads `get_state` directly.

**2. Hand-drawn mocks in a three-gate process.** A design gate, a revision gate
and a build gate. Two models from different vendors that could see images made
a **hand-written SVG mock** of the board for a person to sign off, and then the
scene hook was built against the approved spec. It was piloted on one game
(Wonderland's War) and failed at its central deliverable: models put components
together and configure them; they do not draw. The mock was the run's biggest
token cost, the source of its file corruption (control characters, trailing
garbage, a deleted spec), and could not be judged by its own author, since no
model sees its own geometry. Dropped, along with the whole gate machinery.

**The part a commit log hides.** Read one by one, the fixes that followed that
pilot looked routine ("normalized id matching", "substance over key spelling").
They were not. Each one **walked back a safeguard that should never have
existed** — a check that keys were spelled exactly, a search for ids that could
never succeed, a tool the process insisted on. The pilot's audit measured about
2.8 hours of useful work against about 5.5 hours of waste, and nearly all the
waste came from that structure plus people changing things in the middle of a
run. This is where "start minimal" comes from.

**3. The component library.** What is described above.

**The mistake underneath all of it.** Those runbooks filled up with prohibitions aimed at whoever would run them, instead of knowledge about the work, and the split into two steps was justified by who would do the build rather than by the work. The rule now: **a runbook describes the work, and says nothing about who runs it.** The two drawing runbooks were merged into
[`viz-runbook.md`](./viz-runbook.md) under that rule.

## Lessons from the pilot

- About 2.8 hours of useful work against about 5.5 hours of waste; nearly all
  the waste came from safeguards added in advance (searches for ids that could
  never succeed, checks on exact key spelling, unclear deliverable paths) and
  from people changing things in the middle of a run (edits to the checks that
  tripped its own tamper guard, a botched restart that left two runs racing).
  **Start minimal: the goal, the inputs, where the output goes. Add structure
  only for failures you have actually seen, and name the run where you saw
  them.**
- **Hand-written SVG was the wrong deliverable**: the biggest token cost, the
  source of corruption (control characters, trailing garbage, a deleted spec),
  and impossible for its author to judge (no model sees its own geometry).
  Models put things together and configure them; they should not draw.
- The blind second reading by a different model that could see images PROVED
  its worth: it caught a mirrored region, an invented ring of pieces that
  the board does not have, and a label that couldn't be read, reported honestly. It is
  kept as step 5 of [`viz-runbook.md`](./viz-runbook.md).
- Nothing prescribes a tool for reading printed text off an image. Whoever is
  looking at the work picks their own tools.
