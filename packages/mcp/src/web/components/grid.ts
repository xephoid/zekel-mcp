// <zekel-grid> — a square-cell board via CSS grid: terrain-colored cells,
// round piece tokens with initials and badges, all HTML/CSS. Coordinates use
// the game's move-language frame (x = column, y = row, y increases downward).

import { ZekelElement, esc, themeColor } from './base.js';

import type { GridData } from '@zekel/game-kit';
export type { GridData };

export class ZekelGrid extends ZekelElement<GridData> {
  protected styles(): string {
    return `
      .grid { display: grid; gap: 1px; background: var(--zekel-grid-lines, #0004);
        border: 2px solid var(--zekel-grid-lines, #0004); border-radius: 4px;
        width: fit-content; }
      .cell { width: var(--zekel-cell, 34px); height: var(--zekel-cell, 34px);
        background: var(--zekel-grid-bg, #cfd8c3); position: relative; cursor: pointer;
        display: flex; align-items: center; justify-content: center; }
      .tok { width: 78%; height: 78%; border-radius: 50%; border: 2px solid #000a;
        color: #fff; font-size: 9px; font-weight: 700; text-shadow: 0 1px 1px #000b;
        display: flex; align-items: center; justify-content: center; }
      .tok + .tok { margin-left: -60%; transform: translate(30%, -30%) scale(0.8); }
      .ruler { font-size: 8px; opacity: 0.6; position: absolute; top: 1px; left: 2px; }
    `;
  }

  protected template(g: GridData): string {
    let ext = g.extent;
    if (!ext) {
      const xs = g.cells.map((c) => c.x);
      const ys = g.cells.map((c) => c.y);
      ext = xs.length
        ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) }
        : { minX: 0, minY: 0, maxX: 0, maxY: 0 };
    }
    const byKey = new Map(g.cells.map((c) => [`${c.x},${c.y}`, c]));
    const cols = ext.maxX - ext.minX + 1;
    let cells = '';
    for (let y = ext.minY; y <= ext.maxY; y++) {
      for (let x = ext.minX; x <= ext.maxX; x++) {
        const c = byKey.get(`${x},${y}`);
        const fill = c?.terrain ? `style="background:${themeColor(c.terrain)}"` : '';
        const detail = JSON.stringify({ kind: 'grid-cell', x, y, terrain: c?.terrain ?? null });
        const toks = (c?.pieces ?? [])
          .map((p) => {
            const title = [p.label, ...(p.badges ?? [])].join(' — ');
            return `<span class="tok" style="background:${themeColor(p.colorKey ?? p.label)}" title="${esc(title)}">${esc(p.label.slice(0, 3).toUpperCase())}</span>`;
          })
          .join('');
        const ruler = g.coordinates && (x === ext.minX || y === ext.minY) ? `<span class="ruler">${x === ext.minX ? y : x}</span>` : '';
        cells += `<div class="cell" ${fill} data-select='${esc(detail)}' title="(${x},${y})">${ruler}${toks}</div>`;
      }
    }
    return `
      ${g.label ? `<div class="zone-label">${esc(g.label)}</div>` : ''}
      <div class="grid" style="grid-template-columns: repeat(${cols}, var(--zekel-cell, 34px))">${cells}</div>`;
  }

  protected override render(): void {
    super.render();
    this.wireSelects();
  }
}

customElements.define('zekel-grid', ZekelGrid);
