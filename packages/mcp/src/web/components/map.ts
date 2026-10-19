// <zekel-map> — a positional board: named region nodes absolutely positioned
// at percent coordinates inside a themed container, pieces stacked on nodes.
// Pure HTML/CSS; connection LINES between nodes are deliberately not in the
// library yet (no game has needed them — a game that does declares a custom
// component, per docs/board-viz.md).

import { ZekelElement, esc, themeColor } from './base.js';

import type { MapData } from '@zekel/game-kit';
export type { MapData };

export class ZekelMap extends ZekelElement<MapData> {
  protected styles(): string {
    return `
      .board { position: relative; width: 100%; border-radius: 12px;
        background: var(--zekel-map-bg, #2e3d2f22);
        border: 2px solid var(--zekel-map-border, #0005); overflow: hidden; }
      .node { position: absolute; transform: translate(-50%, -50%); text-align: center; cursor: pointer; }
      .blob { border-radius: 46% 54% 52% 48% / 55% 47% 53% 45%;
        border: 2.5px solid #0007; margin: 0 auto;
        display: flex; align-items: center; justify-content: center; flex-wrap: wrap; gap: 2px;
        box-shadow: inset 0 0 18px #0003; }
      .name { font-size: 11px; font-weight: 700; margin-top: 3px;
        text-shadow: 0 1px 3px var(--zekel-map-label-halo, #fff9); }
      .badges { font-size: 9px; opacity: 0.85; }
      .pc { min-width: 18px; height: 18px; border-radius: 50%; border: 1.5px solid #000a;
        color: #fff; font-size: 9px; font-weight: 700; text-shadow: 0 1px 1px #000b;
        display: inline-flex; align-items: center; justify-content: center; padding: 0 2px; }
    `;
  }

  protected template(m: MapData): string {
    const nodes = m.nodes
      .map((n) => {
        const d = 90 * (n.size ?? 1);
        const detail = JSON.stringify({ kind: 'map-node', id: n.id, label: n.label });
        const pieces = (n.pieces ?? [])
          .map((p) => `<span class="pc" style="background:${themeColor(p.colorKey ?? p.label)}" title="${esc(p.label)}${p.count && p.count > 1 ? ` ×${p.count}` : ''}">${esc(p.label.slice(0, 2).toUpperCase())}${p.count && p.count > 1 ? p.count : ''}</span>`)
          .join('');
        return `<div class="node" style="left:${n.x}%;top:${n.y}%" data-select='${esc(detail)}' title="${esc(n.label)}">
            <div class="blob" style="width:${d}px;height:${d * 0.72}px;background:${themeColor(n.colorKey ?? n.label)}">${pieces}</div>
            <div class="name">${esc(n.label)}</div>
            ${n.badges?.length ? `<div class="badges">${n.badges.map(esc).join(' · ')}</div>` : ''}
          </div>`;
      })
      .join('');
    return `
      ${m.label ? `<div class="zone-label">${esc(m.label)}</div>` : ''}
      <div class="board" style="padding-top:${m.aspect ?? 62}%">${nodes}</div>`;
  }

  protected override render(): void {
    super.render();
    this.wireSelects();
  }
}

customElements.define('zekel-map', ZekelMap);
