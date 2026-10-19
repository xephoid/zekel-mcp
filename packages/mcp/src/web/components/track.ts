// <zekel-track> — a line (or ring) of spaces: score tracks, forge tracks, the
// tea-party plate ring. Spaces can be filled, hold pieces, and carry markers
// pointing at them. Cyclic tracks close the loop visually with a return arrow.

import { ZekelElement, esc, themeColor } from './base.js';

import type { TrackData } from '@zekel/game-kit';
export type { TrackData };

export class ZekelTrack extends ZekelElement<TrackData> {
  protected styles(): string {
    return `
      .track { display: flex; flex-wrap: wrap; gap: 2px 8px; align-items: flex-end; padding-top: 18px; }
      .space { position: relative; width: 40px; text-align: center; cursor: pointer; }
      .cell {
        width: 34px; height: 34px; margin: 0 auto; border-radius: 50%;
        border: 2px solid var(--zekel-track-border, #0007);
        background: var(--zekel-track-space, #fff3);
        display: flex; align-items: center; justify-content: center;
        font-size: 11px; font-weight: 600;
      }
      .space.filled .cell { background: var(--zekel-track-filled, #b8860b); color: #fff; }
      .idx { font-size: 9px; opacity: 0.7; margin-top: 1px; }
      .pieces { position: absolute; top: -8px; left: 0; right: 0; display: flex; justify-content: center; gap: 2px; }
      .pawn { width: 12px; height: 12px; border-radius: 50% 50% 40% 40%; border: 1.5px solid #0008; }
      .marker { position: absolute; top: -18px; left: 0; right: 0; font-size: 9px; font-weight: 700; }
      .marker::after { content: '▼'; display: block; font-size: 8px; }
      .loop { align-self: center; font-size: 18px; opacity: 0.6; padding-bottom: 12px; }
    `;
  }

  protected template(t: TrackData): string {
    const markerAt = new Map<string, { label: string; colorKey?: string }[]>();
    for (const m of t.markers ?? []) {
      const k = String(m.at);
      if (!markerAt.has(k)) markerAt.set(k, []);
      markerAt.get(k)!.push(m);
    }
    const spaces = t.spaces
      .map((sp) => {
        const detail = JSON.stringify({ kind: 'track-space', index: sp.index, label: sp.label ?? null });
        const pieces = (sp.pieces ?? [])
          .map((p) => `<span class="pawn" style="background:${themeColor(p.colorKey ?? p.label)}" title="${esc(p.label)}"></span>`)
          .join('');
        const markers = (markerAt.get(String(sp.index)) ?? [])
          .map((m) => `<span class="marker" style="color:${themeColor(m.colorKey ?? m.label)}">${esc(m.label)}</span>`)
          .join('');
        return `<div class="space ${sp.filled ? 'filled' : ''}" data-select='${esc(detail)}' title="${esc(sp.label ?? sp.index)}">
            ${markers}
            <div class="pieces">${pieces}</div>
            <div class="cell">${esc(sp.label ? sp.label.slice(0, 4) : sp.index)}</div>
            ${sp.label ? `<div class="idx">${esc(sp.index)}</div>` : ''}
          </div>`;
      })
      .join('');
    return `
      ${t.label ? `<div class="zone-label">${esc(t.label)}${t.cyclic ? ' (ring)' : ''}</div>` : ''}
      <div class="track">${spaces}${t.cyclic ? '<span class="loop" title="loops back to the first space">↻</span>' : ''}</div>`;
  }

  protected override render(): void {
    super.render();
    this.wireSelects();
  }
}

customElements.define('zekel-track', ZekelTrack);
