// <zekel-pool> — a supply of counted things: resource chips with quantities.

import { ZekelElement, esc, themeColor } from './base.js';

import type { PoolData } from '@zekel/game-kit';
export type { PoolData };

export class ZekelPool extends ZekelElement<PoolData> {
  protected styles(): string {
    return `
      .items { display: flex; flex-wrap: wrap; gap: 5px; }
      .item {
        display: inline-flex; align-items: center; gap: 5px;
        border: 1.5px solid #0004; border-radius: 12px; padding: 2px 9px 2px 3px;
        font-size: 12px; background: var(--zekel-pool-bg, #8881); cursor: pointer;
      }
      .swatch { width: 16px; height: 16px; border-radius: 50%; border: 1.5px solid #0006; }
      b { font-variant-numeric: tabular-nums; }
    `;
  }

  protected template(p: PoolData): string {
    const items = p.items
      .map((it) => {
        const detail = JSON.stringify({ kind: 'pool-item', label: it.label });
        return `<span class="item" data-select='${esc(detail)}'>
          <span class="swatch" style="background:${themeColor(it.colorKey ?? it.label)}"></span>
          ${esc(it.label)} <b>×${it.count}</b></span>`;
      })
      .join('');
    return `${p.label ? `<div class="zone-label">${esc(p.label)}</div>` : ''}<div class="items">${items}</div>`;
  }

  protected override render(): void {
    super.render();
    this.wireSelects();
  }
}

customElements.define('zekel-pool', ZekelPool);
