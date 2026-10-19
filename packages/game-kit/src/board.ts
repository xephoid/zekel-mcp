// The data shapes a game's browser board drawing (viz/board.ts) works with:
// the GameBoardModule a drawing exports, and the data each zekel-* component
// takes. Types only, so a drawing's `import type` from the kit is erased when
// compiled and nothing from the kit reaches the browser.
//
// The components themselves (the custom elements that draw these) live with
// the server's web debug client in src/web/components; they read these types
// from here. Design record: docs/board-viz.md; host contract: src/web/host.ts.

export interface GameBoardModule {
  /** Render the table for one viewer into `container`. Called after every
   *  refresh; implementations should rebuild (clear + render) — the host does
   *  not diff. `view` is the get_state payload for `viewerId`.
   *
   *  `previousView` is optional: when present (a digital-mode AI-turn replay —
   *  the host page is stepping through run_ai_turn's per-move snapshots), it is
   *  the player view AS IT STOOD after the PREVIOUS move. Glue that wants to
   *  animate the delta can diff the two; glue that just redraws can ignore it
   *  entirely and render `view` as usual. */
  renderBoard(view: Record<string, unknown>, container: HTMLElement, viewerId: string, previousView?: Record<string, unknown>): void;
}

export interface CardData {
  label: string;
  id?: string;
  /** Theme key for the card's face color (owner, suit, type...). */
  colorKey?: string;
  face?: 'up' | 'down';
  /** Tapped/exhausted (90) or upside down (180). */
  rotation?: 0 | 90 | 180 | 270;
  count?: number;
  badges?: string[];
}

export interface CardZoneData {
  label?: string;
  mode: 'row' | 'fan' | 'pile';
  cards?: CardData[];
  /** Hidden pile: no cards, just how many. */
  countOnly?: number;
}

export interface BagData {
  label?: string;
  owner?: string;
  /** Composition when the viewer may know it (owner's own bag). */
  contents?: { label: string; count: number; colorKey?: string }[];
  /** Otherwise just how many chips are inside. */
  count?: number;
  /** Pulled chips in pull order. */
  revealRow?: CardData[];
  /** 'drawing' | 'busted' | 'halted' | game-defined. */
  status?: string;
}

export interface GridData {
  label?: string;
  /** Fixed extent so empty rim cells render; defaults to the cells' bounds. */
  extent?: { minX: number; minY: number; maxX: number; maxY: number };
  cells: {
    x: number;
    y: number;
    /** Theme key for the cell fill. */
    terrain?: string;
    pieces?: { label: string; colorKey?: string; badges?: string[] }[];
  }[];
  /** Show coordinate rulers (debugging boards). */
  coordinates?: boolean;
}

export interface PoolData {
  label?: string;
  items: { label: string; count: number; colorKey?: string }[];
}

export interface MapData {
  label?: string;
  /** Board aspect ratio as height/width percent (default 62 ≈ landscape board). */
  aspect?: number;
  nodes: {
    id: string;
    label: string;
    /** Percent of container, 0-100. */
    x: number;
    y: number;
    /** Theme key for the region blob (defaults to the label). */
    colorKey?: string;
    /** Relative blob size, 1 = default. */
    size?: number;
    badges?: string[];
    pieces?: { label: string; colorKey?: string; count?: number }[];
  }[];
}

export interface TrackData {
  label?: string;
  cyclic?: boolean;
  spaces: {
    index: number | string;
    label?: string;
    filled?: boolean;
    /** Pieces standing ON the space (pawns): theme-colored dots. */
    pieces?: { label: string; colorKey?: string }[];
  }[];
  /** Markers pointing at a space from above (time/reputation style). */
  markers?: { label: string; colorKey?: string; at: number | string }[];
}

export interface TableauData {
  label?: string;
  /** Theme key for the board's accent (usually the faction/player). */
  owner?: string;
  active?: boolean;
  stats?: { label: string; value: string | number; max?: number }[];
}
