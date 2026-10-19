// The board-host contract (docs/board-viz.md, docs/viz-runbook.md).
//
// A game opts into board rendering by shipping a GLUE MODULE at
// `src/games/<game-id>/viz/board.ts` (compiled and served to the browser at
// `/web/games/<game-id>/viz/board.js`). The debug client's board host
// dynamically imports it and calls `renderBoard` after every state refresh.
//
// The glue module's whole job: read the PLAYER VIEW (the `get_state` payload —
// already privacy-filtered and structurally complete per post-port §1a),
// instantiate `zekel-*` components, and place them in the container. The HOST
// loads the component library before importing any glue module, so glue just
// document.createElement()s the tags (no browser-path imports; use TYPE-ONLY
// imports from src/web/components for the data shapes). Theming is CSS custom
// properties — set them on the container (or inject a <style> into it).
// Interaction: components emit bubbling `zekel-select` events; the host page
// listens on the container, so the glue wires nothing unless a game needs
// custom detail.
//
// Example: a game's own viz/board.ts reads its view and creates zekel-* elements.

export type { GameBoardModule } from '@zekel/game-kit';
