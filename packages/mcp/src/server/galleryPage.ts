// The zekel-* component gallery (docs/board-viz.md) — every library component
// rendered with sample data, plus a live theming demo and an interaction log.
// Three jobs: Zeke's review surface, the reference a viz-planning model is
// pointed at, and the place where component breakage becomes visible.
// Served at GET /gallery; the components load as native ES modules from /web/.

export const GALLERY_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>zekel component gallery</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0 auto; padding: 1rem; max-width: 1150px; }
  h1 { font-size: 1.3rem; }
  section { border: 1px solid #8885; border-radius: 10px; padding: 12px 14px; margin-bottom: 14px; }
  h2 { font-size: 1rem; margin: 0 0 2px; font-family: ui-monospace, monospace; }
  .desc { font-size: 12px; opacity: 0.75; margin: 0 0 10px; }
  .samples { display: flex; gap: 22px; flex-wrap: wrap; align-items: flex-start; }
  .sample > .cap { font-size: 11px; opacity: 0.6; margin-bottom: 4px; }
  #eventlog { position: fixed; right: 10px; bottom: 10px; width: 270px; max-height: 30vh;
    overflow-y: auto; background: #000c; color: #9f9; font: 11px ui-monospace, monospace;
    border-radius: 8px; padding: 8px; }
  #eventlog div { border-bottom: 1px solid #fff2; padding: 2px 0; }
  .theme-demo { --zekel-c-lakeshore: #3fa7d6; --zekel-c-hilltop: #9b59b6;
    --zekel-c-red-keep: #c0392b; --zekel-c-forest: #2e7d32; --zekel-c-meadow: #f4a940;
    --zekel-c-hero: #1a5276; --zekel-c-villain: #922b21; }
</style>
</head>
<body>
<h1>zekel component gallery</h1>
<p class="desc">Every component takes its data via the <code>data</code> property, themes via
<code>--zekel-c-*</code> CSS variables (hashed fallback colors when unthemed), and emits
<code>zekel-select</code> events on click — watch the log bottom-right.</p>

<section>
  <h2>&lt;zekel-card&gt;</h2>
  <p class="desc">One physical card. Face up/down, rotation (tapped), count collapse, badges.</p>
  <div class="samples" id="s-card"></div>
</section>

<section>
  <h2>&lt;zekel-card-zone&gt;</h2>
  <p class="desc">Card displays: row (a market), fan (a hand), pile (deck/discard), count-only (hidden pile).</p>
  <div class="samples" id="s-cardzone"></div>
</section>

<section>
  <h2>&lt;zekel-tableau&gt;</h2>
  <p class="desc">A player board: accent color from the owner key, stats with optional meters, and SLOTTED children — nest any other component inside.</p>
  <div class="samples" id="s-tableau"></div>
</section>

<section>
  <h2>&lt;zekel-bag&gt;</h2>
  <p class="desc">The push-your-luck chip bag: count, known composition (owner view), pulled reveal row, status.</p>
  <div class="samples" id="s-bag"></div>
</section>

<section>
  <h2>&lt;zekel-track&gt;</h2>
  <p class="desc">A line or ring of spaces: filled spaces, standing pawns, pointing markers, cyclic loop.</p>
  <div class="samples" id="s-track"></div>
</section>

<section>
  <h2>&lt;zekel-pool&gt;</h2>
  <p class="desc">Counted supplies.</p>
  <div class="samples" id="s-pool"></div>
</section>

<section>
  <h2>&lt;zekel-grid&gt;</h2>
  <p class="desc">A square-cell board (CSS grid): terrain fills, stacked piece tokens, move-language coordinates in the click events.</p>
  <div class="samples" id="s-grid"></div>
</section>

<section>
  <h2>&lt;zekel-map&gt;</h2>
  <p class="desc">A positional board: region blobs at percent coordinates, pieces stacked on regions. (Connection lines deliberately not in the library yet.)</p>
  <div class="samples" id="s-map"></div>
</section>

<section class="theme-demo">
  <h2>Theming demo</h2>
  <p class="desc">This section sets <code>--zekel-c-*</code> variables on its wrapper — the same components, recolored purely by CSS. A game's theme is just a stylesheet.</p>
  <div class="samples" id="s-theme"></div>
</section>

<div id="eventlog"><div>zekel-select events appear here…</div></div>

<script type="module">
import '/web/components/index.js';

function put(host, tag, data, caption, slotted) {
  var wrap = document.createElement('div');
  wrap.className = 'sample';
  if (caption) {
    var cap = document.createElement('div');
    cap.className = 'cap';
    cap.textContent = caption;
    wrap.appendChild(cap);
  }
  var el = document.createElement(tag);
  el.data = data;
  (slotted || []).forEach(function (child) { el.appendChild(child); });
  wrap.appendChild(el);
  document.getElementById(host).appendChild(wrap);
  return el;
}

function make(tag, data) {
  var el = document.createElement(tag);
  el.data = data;
  return el;
}

// --- zekel-card
put('s-card', 'zekel-card', { label: 'Troll', colorKey: 'forest', badges: ['STR 7', '2 pts'] }, 'face up + badges');
put('s-card', 'zekel-card', { label: 'Face down', face: 'down' }, 'face down');
put('s-card', 'zekel-card', { label: 'Warrior', colorKey: 'villain', count: 4 }, 'count collapse');
put('s-card', 'zekel-card', { label: 'Exhausted', colorKey: 'hero', rotation: 90 }, 'tapped (rotation 90)');

// --- zekel-card-zone
put('s-cardzone', 'zekel-card-zone', { label: 'The Market', mode: 'row', cards: [
  { label: 'Sword', colorKey: 'hero' }, { label: 'Shield', colorKey: 'hero' },
  { label: 'Dragon', colorKey: 'villain', badges: ['5 pts'] } ] }, 'row');
put('s-cardzone', 'zekel-card-zone', { label: 'Your hand', mode: 'fan', cards: [
  { label: 'Ace' }, { label: 'Two' }, { label: 'Three' }, { label: 'Four' }, { label: 'Five' } ] }, 'fan (hover)');
put('s-cardzone', 'zekel-card-zone', { label: 'Discard', mode: 'pile', cards: [
  { label: 'Old card' }, { label: 'Older card' }, { label: 'Top of pile', colorKey: 'meadow' } ] }, 'pile (top + depth)');
put('s-cardzone', 'zekel-card-zone', { label: 'Draw deck', countOnly: 17 }, 'hidden pile (count only)');

// --- zekel-tableau (with nesting)
put('s-tableau', 'zekel-tableau', { label: 'Hero Player', owner: 'hero', active: true, stats: [
  { label: 'HP', value: 7, max: 10 }, { label: 'Gold', value: 12 }, { label: 'VP', value: 3 } ] }, 'stats + meters + to-move');
put('s-tableau', 'zekel-tableau', { label: 'Villain Player', owner: 'villain', stats: [
  { label: 'HP', value: 4, max: 10 } ] }, 'with a nested hand + bag', [
    make('zekel-card-zone', { label: 'Hand', mode: 'fan', cards: [ { label: 'Hex' }, { label: 'Curse' } ] }),
    make('zekel-bag', { count: 9, status: 'drawing' }),
  ]);

// --- zekel-bag
put('s-bag', 'zekel-bag', { label: 'Opponent bag (count only)', count: 12 }, 'hidden composition');
put('s-bag', 'zekel-bag', { label: 'Your bag', contents: [
  { label: 'Soldier', count: 5, colorKey: 'villain' }, { label: 'Scout', count: 2, colorKey: 'hero' },
  { label: 'Trouble', count: 3 } ],
  revealRow: [ { label: 'Soldier', colorKey: 'villain' }, { label: 'Trouble' } ],
  status: 'busted' }, 'composition + pulls + busted');

// --- zekel-track
put('s-track', 'zekel-track', { label: 'Score track', spaces: [
  { index: 0 }, { index: 1 }, { index: 2, pieces: [ { label: 'Hero pawn', colorKey: 'hero' } ] },
  { index: 3 }, { index: 4, pieces: [ { label: 'Villain pawn', colorKey: 'villain' }, { label: 'Neutral', colorKey: 'meadow' } ] },
  { index: 5 } ],
  markers: [ { label: 'END', at: 5 } ] }, 'pawns + a marker');
put('s-track', 'zekel-track', { label: 'Plate ring', cyclic: true, spaces: [
  { index: 0, label: 'Tea' }, { index: 1, label: 'Cake', filled: true }, { index: 2, label: 'Jam' },
  { index: 3, label: 'Scone' }, { index: 4, label: 'Sugar' } ] }, 'cyclic + filled + labels');

// --- zekel-pool
put('s-pool', 'zekel-pool', { label: 'Supply', items: [
  { label: 'Coal', count: 8 }, { label: 'Iron', count: 5 }, { label: 'Gold', count: 2, colorKey: 'meadow' } ] }, '');

// --- zekel-grid
put('s-grid', 'zekel-grid', { label: 'Sample grid (corner)', coordinates: true,
  extent: { minX: 1, minY: 1, maxX: 8, maxY: 6 }, cells: [
  { x: 3, y: 2, pieces: [ { label: 'Ranger', colorKey: 'hero', badges: ['HP 3'] } ] },
  { x: 5, y: 4, terrain: 'forest' }, { x: 6, y: 4, terrain: 'forest' },
  { x: 4, y: 3, pieces: [ { label: 'Token' } ] },
  { x: 7, y: 2, pieces: [ { label: 'Rival', colorKey: 'villain' }, { label: 'Marker', colorKey: 'meadow' } ] } ] }, '');

// --- zekel-map
put('s-map', 'zekel-map', { label: 'Five regions', nodes: [
  { id: 'lakeshore', label: 'Lakeshore', x: 22, y: 26, pieces: [ { label: 'Hero', colorKey: 'hero', count: 3 } ] },
  { id: 'hilltop', label: 'Hilltop', x: 76, y: 24, badges: ['scoring x2'] },
  { id: 'meadow', label: 'Meadow', x: 20, y: 72, colorKey: 'meadow' },
  { id: 'forest', label: 'Deep Forest', x: 50, y: 66, colorKey: 'forest', size: 1.2,
    pieces: [ { label: 'Villain', colorKey: 'villain', count: 2 }, { label: 'Hero', colorKey: 'hero' } ] },
  { id: 'red-keep', label: 'Red Keep', x: 80, y: 70, colorKey: 'red-keep' } ] }, '');

// --- theming demo: same components, recolored by the wrapper's CSS vars
put('s-theme', 'zekel-map', { nodes: [
  { id: 'lakeshore', label: 'Lakeshore', x: 25, y: 30 },
  { id: 'hilltop', label: 'Hilltop', x: 72, y: 28 },
  { id: 'red-keep', label: 'Red Keep', x: 75, y: 72 } ] }, 'themed map');
put('s-theme', 'zekel-pool', { items: [
  { label: 'Lakeshore', count: 1 }, { label: 'Hilltop', count: 1 },
  { label: 'Red Keep', count: 1 }, { label: 'Unthemed Thing', count: 1 } ] }, 'themed vs hashed fallback');

// --- interaction log
var log = document.getElementById('eventlog');
document.addEventListener('zekel-select', function (ev) {
  var d = document.createElement('div');
  d.textContent = JSON.stringify(ev.detail);
  log.prepend(d);
});
</script>
</body>
</html>
`;
