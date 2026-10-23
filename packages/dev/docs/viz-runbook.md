# Visualization runbook

How to take a game from "post-port done" to "its table is drawn live in the web
debug page, and the person who owns the physical copy recognizes it." This is
one gate. It is optional for each game, and it comes after post-port:

```
post-port ──▶ VIZ (this one, optional)
complete views     the board on screen
```

| Gate | Runbook | Owns |
|---|---|---|
| post-port | [`post-port-runbook.md`](./post-port-runbook.md) | §1a view completeness — the prerequisite that makes this possible |
| **Viz** (this one) | `viz-runbook.md` | the drawing module, its colors and layout, and a person's verdict on the live board |

> **What this is for.** The board exists so an implementation can be checked
> fast, by eye, with no language model in the loop (see
> [`board-viz.md`](./board-viz.md)). Looking like the printed components is an
> experiment on top of that — worth doing, and allowed to be imperfect. Size
> your effort to match: a board that shows every table fact clearly and reads
> roughly like the real table is a **pass**; a beautiful board that silently
> leaves out a zone is a **fail**.

> **Compose, don't draw.** The `zekel-*` component library is the only way to
> draw. Do not make mock images or hand-written SVG at any point. An early
> pilot spent most of its budget on a hand-drawn mock whose defects could not
> exist in the real renderer, and which its own author could not judge — no
> model sees its own geometry. Looks are reviewed on the live board.

> **History.** This used to be two gates (planning the drawing, then building
> it). The split was justified by a limit of whoever would do the build, not by
> the work, and it put the review of *looks* on a prose document instead of on
> a screen. The two were merged. See [`board-viz.md`](./board-viz.md), "How we
> got here".

---

## The deliverable

Three things in the game's package:

1. **`src/viz/board.ts`** — the drawing module (also called the glue module:
   it glues the game's view to the components). It reads the game's
   `get_state` player view and creates `zekel-*` components. It exports what
   the board host expects (`GameBoardModule`, in `@zekel/game-kit`'s
   `board.ts`), and takes the component data types from `@zekel/game-kit` as
   **type-only** imports. The debug page loads it from
   `/web/games/<game-id>/viz/board.js` and calls it after every refresh.
   **The game must also name its folder:**
   `readonly webAssetsDir = folderOf(import.meta.url)` on the `Game` in
   `index.ts` (`folderOf` comes from `@zekel/game-kit`). The server only serves
   a game that names one; without it the drawing returns 404. Anything the
   drawing imports at run time must sit inside the game's own folder, because
   it is loaded in the browser.
2. **`src/components/`** — any custom components, when no library component
   fits.
3. **`VIZ-NOTES.md`** in the game's package folder — the record, written
   **during** the work, not before it. Like `PORT-NOTES.md` and unlike
   `PORT-PLAN.md`: it records what was built and what was decided, and it is
   where the person's verdict and any rounds of fixes land.

The reference drawing module is Sweetlands Imperium's,
`packages/sweetlands-imperium/src/viz/board.ts` in zekel-games (no custom
components). Its `index.ts` shows the `webAssetsDir` line.

---

## The method underneath

### 1. The view is the full list, and coverage is a check — not a review

A drawing usually fails the same way a port does: not a zone drawn wrong, but a
zone **never noticed** — a card display or track that is in the view and got no
place on screen.

Unlike a port's missing rule, this one can be counted exactly. The full list is
the set of table-visible fields the game's `views.ts` serves (complete, per
post-port §1a). The covered list is the set of fields the drawing module
actually reads. The difference can be computed, so **compute it — do not ask a
person to compare two prose lists.** Checking set membership is what people do
worst and machines do perfectly.

The coverage check is a test, written once for the whole project with no
per-game code. It does this for every game that has a `viz/board.ts`:

- Build an all-AI session at the game's minimum player count.
- Play it with the AI past setup and into real play (around 40 moves). A
  setup-phase view hides most of the table, and coverage against it would pass
  a module that draws almost nothing.
- Get the first seat's player view, and wrap it in a `Proxy` that records every
  top-level key read.
- Run the module's `renderBoard` against it in a jsdom DOM. If it throws, the
  test fails: the module must survive a live view.
- Compare. Every field served but never read is either a gap or a deliberate
  omission, and **a deliberate omission must be declared** in the module:

```ts
// src/viz/board.ts
export const notRendered = ['game', 'ascii'] as const;   // with a comment saying why
```

Silence is not allowed, and the list cannot go stale: the test also fails if
`notRendered` names a field the view no longer serves, or one the module
actually reads. Add a field to `views.ts` and the test fails until someone draws
it or names it. Also make the test fail when it finds no drawing modules at
all, so an empty run can't pass by accident.

Coverage is **top-level only**. A field such as `view.players` counts as read
the moment the module touches it, even if it ignores half of each player. Checking
every nested key drowns in per-item noise, and the failure this guards against is
a whole zone with no place on screen. The nested detail is your walk in §2.

Fields that are bookkeeping rather than things on the table (directions, logs,
menus) are out of scope — but they still go in `notRendered` with a reason, so
the choice to leave them out can be reviewed rather than hidden.

### 2. Looks come from the printed sources, read by looking — then read again, independently

Colors, arrangement, and any positions come from the board photo and component
images, by actually looking at them. Never from memory of the game.

Then have a **second, independent look** at the same images check what was
produced. This is the one part of the old two-gate process that proved its
worth: a blind second reading caught a mirrored region, an invented ring of 25
plates where the board shows 11, and a label that couldn't be read, reported
honestly instead of guessed. That kind of defect — *the board was confidently
misread* — can't be seen at the person's review, because a confidently wrong
board still looks like a board. Independence is the whole value: the second
look reads the source first and compares afterward. It never reviews the colors
and positions with them already in hand.

### 3. The person's verdict on the LIVE board is the gate

Not a document, not a screenshot, not a self-assessment. The person opens the
debug page, plays a session, and judges the board against their physical copy.
Everything before that is work, not the gate.

---

## The process

Build first (`pnpm build`); the debug page serves compiled modules. Then start
the server over HTTP with an in-memory store — in zekel-games:
`MCP_TRANSPORT=http SESSION_STORE=memory node examples/serve.mjs` — and open
`http://localhost:3000/debug`. The component gallery is at
`http://localhost:3000/gallery`.

### 0. Inputs

- **The served view** — the game's `views.ts` (what `get_state` returns) and
  its data files (printed names and values). Note the player counts, and where
  the table differs by count.
- **The printed sources** — board and setup photos, player boards, card images.
  Record which images informed which decision.
- **The component library** — the source in `@zekel/mcp`'s `web/components/`
  (`packages/mcp/src/web/components/` in zekel-mcp) and the gallery, so the
  mapping uses real component names and real options rather than remembered
  ones.
- **The host contract** — `packages/mcp/src/web/host.ts` in zekel-mcp, the
  `GameBoardModule` type in `@zekel/game-kit`'s `board.ts`, and the reference
  drawing module.

One caution from experience: sessions that collected many images in their own
context have died on request-size limits. Keep your looks bounded.

### 1. Walk the view

List every table-visible field of the player view, grouped the way the physical
table groups them (main board, shared displays, per-player boards, supplies).
This list is the full list for coverage; §2 must use all of it.

### 2. Map each field to a component, and build it

One row per field: **view field · component · settings · interaction**. The
settings must be specific — mode (row/pile/fan for card zones, cyclic for
tracks), what supplies the labels, counts vs. contents, per-seat vs. shared. A
row that says only "cards" has hidden the work.

Build as you map. These rules carry weight, and all come from standing
conventions (see [`building-a-game.md`](./building-a-game.md)):

- **Read the player view only.** Privacy comes from `getPlayerView`'s
  filtering; the drawing must never reach into state the view holds back, and
  draws count-only zones as counts.
- **Printed names on labels** — the view carries them (post-port §1a); never
  show internal ids to the person.
- **Per-seat zones are drawn per seat**, viewer's seat first.
- **Interactions**: components send bubbling `zekel-select` events and the host
  page listens on the container, so a game wires nothing unless it needs custom
  detail.

### 3. Custom components

Where no library component fits, build one in the game's `src/components/`,
following the library's conventions (a custom element, `zekel-` prefix with the
game name in it, HTML/CSS only, data in through a property, events out). Record
one sentence on why the library didn't cover it. Do not change the shared
library — a component moves into the library later, when a second game wants
the same thing.

### 4. Layout and colors

- **Layout** — take the arrangement from how the physical table is laid out
  (the setup photo), adapted to a screen: main board largest, shared displays
  next to it, per-player boards in a row. CSS grid-template-areas is a good
  default because things cannot overlap in it, but the reference module uses
  flex; pick what fits and don't fight the format.
- **Colors** — CSS custom properties on the container, one per region /
  faction / terrain / track key, read by LOOKING at the printed components.
  Cite the source image for each color in the notes. Use mid-tones that stay
  readable on light and dark backgrounds.
- **Positions** — for a positional board (`zekel-map`), each node as a percent of
  the container, read from the board photo. Also state positions relative to
  each other in prose ("upper-left, bordering X"), so the second look can catch
  a typo in a coordinate.

### 5. The independent look

Have a second reading of the board photo and component images check the colors
and positions from §4: mirrored or rotated regions, miscounted repeated
elements, colors that contradict the photo, labels that were guessed rather than
read. Record the findings and what was done about each in VIZ-NOTES.

Anything the sources truly didn't show — a label you can't read, an area the
photo crops, a color you can't tell apart — is an **open question for the
person**, never a guess. Say what you looked at and what you couldn't read.

### 6. The build's own checks

The objective minimum, all mechanical:

- `pnpm typecheck` (where your project has it) and `pnpm build` pass.
- The module draws a real session's view without throwing, and every mapped
  zone is created — a zone that throws or is silently skipped is a failure.
- The debug page loads it: `/web/games/<game-id>/viz/board.js` is served and
  the board appears when you open a session of the game at `/debug`.
- The coverage check passes (§1 of the method): every served view field is
  drawn or declared in `notRendered` with a reason.

What the board **looks like** is deliberately not on this list. Do not judge
your own board's appearance.

### 7. The person's review

The person opens the debug page, plays a session, and judges the live board
against their physical copy: **done**, **revise**, or **park**. Findings are
added to VIZ-NOTES; fixes go back through whichever step was wrong. The gate
passes only on the person's explicit verdict, recorded in the notes.

---

## Per-game checklist

- [ ] §0 Inputs gathered: `views.ts` and data files read, source images listed,
      component library + gallery + host contract read.
- [ ] §1 View walked: every table-visible field listed; exclusions stated.
- [ ] §2 Every field mapped and built — view only, printed names, per-seat
      zones per seat, interactions wired.
- [ ] §3 Custom components justified in one sentence; shared library untouched.
- [ ] §4 Layout and colors taken from the printed sources, each color cited.
- [ ] §5 Independent second look run; each finding dealt with; nothing guessed —
      unreadable things raised as open questions.
- [ ] §6 typecheck + build pass; coverage check passes (every served field
      drawn or declared); debug page loads the module.
- [ ] §7 **The person's verdict on the live board recorded in VIZ-NOTES.md.**

---

## Template for the notes

`VIZ-NOTES.md` in the game's package folder:

```
# Viz notes — <Game>

1. Inputs (view source files read; source images used and what each informed)
2. View walk + coverage (every table-visible field; where each is drawn;
   what's in `notRendered` and why)
3. Component map (view field · component · settings · interaction)
4. Custom components (name · why the library didn't fit)
5. Layout and colors (arrangement and its source; every color with a source
   cited; map node positions with prose relations)
6. Independent look (findings + what was done about each)
7. Open questions (what couldn't be read; what the person must answer)
8. Checks (typecheck/build/render/coverage results)
9. Verdict (person, date, done/revise/park; rounds of fixes appended)
```
