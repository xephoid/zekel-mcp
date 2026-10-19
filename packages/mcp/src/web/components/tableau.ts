// <zekel-tableau> — a player board / stat panel: a titled card with stat rows
// (meter bar when a max is known) and a slot for nested zones (a hand, a bag,
// per-board tracks) — composition IS the nesting story.

import { ZekelElement, esc, themeColor } from './base.js';

import type { TableauData } from '@zekel/game-kit';
export type { TableauData };

export class ZekelTableau extends ZekelElement<TableauData> {
  protected styles(): string {
    return `
      .board {
        border: 2px solid var(--zekel-tableau-border, #8886);
        border-left-width: 8px;
        border-radius: 10px; padding: 8px 10px;
        background: var(--zekel-tableau-bg, #8881);
        min-width: 150px;
      }
      .board.active { box-shadow: 0 0 0 2px var(--zekel-active, #4a8); }
      .title { font-weight: 700; font-size: 13px; margin-bottom: 6px; display: flex; gap: 6px; align-items: center; }
      .dot { width: 10px; height: 10px; border-radius: 50%; display: inline-block; }
      .turn { font-size: 10px; background: var(--zekel-active, #4a8); color: #fff; border-radius: 8px; padding: 0 6px; }
      .stat { display: flex; justify-content: space-between; gap: 10px; font-size: 12px; padding: 1px 0; }
      .stat b { font-variant-numeric: tabular-nums; }
      .meter { height: 5px; border-radius: 3px; background: #8884; margin: 1px 0 4px; overflow: hidden; }
      .meter div { height: 100%; background: var(--zekel-meter, #4a8); }
      ::slotted(*) { margin-top: 8px; }
    `;
  }

  protected template(t: TableauData): string {
    const accent = t.owner ? themeColor(t.owner) : 'transparent';
    const stats = (t.stats ?? [])
      .map((s) => {
        const meter =
          s.max !== undefined && typeof s.value === 'number'
            ? `<div class="meter"><div style="width:${Math.max(0, Math.min(100, (s.value / s.max) * 100))}%"></div></div>`
            : '';
        return `<div class="stat"><span>${esc(s.label)}</span><b>${esc(s.value)}${s.max !== undefined ? ` / ${s.max}` : ''}</b></div>${meter}`;
      })
      .join('');
    return `
      <div class="board ${t.active ? 'active' : ''}" style="border-left-color:${accent}">
        <div class="title">
          ${t.owner ? `<span class="dot" style="background:${accent}"></span>` : ''}
          ${esc(t.label ?? t.owner ?? '')}
          ${t.active ? '<span class="turn">to move</span>' : ''}
        </div>
        ${stats}
        <slot></slot>
      </div>`;
  }
}

customElements.define('zekel-tableau', ZekelTableau);
