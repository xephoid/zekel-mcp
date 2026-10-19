// <zekel-card-zone> — a card display: row (market/landscape), fan (a hand),
// or pile (deck/discard; top card visible, depth badge). Hidden piles render
// count-only.

import { ZekelElement, esc } from './base.js';
import type { CardData } from './card.js';

import type { CardZoneData } from '@zekel/game-kit';
export type { CardZoneData };

export class ZekelCardZone extends ZekelElement<CardZoneData> {
  protected styles(): string {
    return `
      .row { display: flex; flex-wrap: wrap; gap: 6px; align-items: flex-start; }
      .fan { display: flex; }
      .fan zekel-card { margin-left: -34px; transition: margin 0.15s, transform 0.15s; }
      .fan zekel-card:first-child { margin-left: 0; }
      .fan zekel-card:hover { transform: translateY(-8px); }
      .pile { position: relative; display: inline-block; }
      .pile zekel-card { position: absolute; top: 0; left: 0; }
      .pile zekel-card:last-child { position: relative; }
      .depth { position: absolute; right: -8px; top: -8px; z-index: 1;
        background: var(--zekel-badge, #345); color: #fff; border-radius: 10px;
        font-size: 11px; padding: 1px 7px; }
      .empty { opacity: 0.6; font-size: 12px; border: 1.5px dashed #8888;
        border-radius: 8px; width: var(--zekel-card-w, 72px); height: var(--zekel-card-h, 100px);
        display: flex; align-items: center; justify-content: center; }
    `;
  }

  protected template(z: CardZoneData): string {
    const label = z.label ? `<div class="zone-label">${esc(z.label)}</div>` : '';
    if (z.cards === undefined) {
      // Count-only (hidden pile or empty display).
      const n = z.countOnly ?? 0;
      const back = n > 0
        ? `<div class="pile"><span class="depth">${n}</span><zekel-card id="back"></zekel-card></div>`
        : `<div class="empty">empty</div>`;
      return `${label}${back}`;
    }
    if (z.cards.length === 0) return `${label}<div class="empty">empty</div>`;
    if (z.mode === 'pile') {
      // Bottom → top; offset a couple of underneath cards for depth feel.
      const top = z.cards[z.cards.length - 1]!;
      return `${label}<div class="pile">
        <span class="depth">${z.cards.length}</span>
        <zekel-card id="top"></zekel-card>
      </div>
      <template id="cards">${esc(JSON.stringify([top]))}</template>`;
    }
    return `${label}<div class="${z.mode}" id="list"></div>
      <template id="cards">${esc(JSON.stringify(z.cards))}</template>`;
  }

  protected override render(): void {
    super.render();
    const z = this.data;
    if (!z || !this.shadowRoot) return;
    // Instantiate child <zekel-card> elements with their data (custom elements
    // compose, but data flows via properties, so wire them after templating).
    if (z.cards === undefined) {
      const back = this.shadowRoot.getElementById('back') as HTMLElement & { data: CardData } | null;
      if (back) back.data = { label: 'Face down', face: 'down' };
      return;
    }
    if (z.mode === 'pile' && z.cards.length > 0) {
      const top = this.shadowRoot.getElementById('top') as HTMLElement & { data: CardData } | null;
      if (top) top.data = z.cards[z.cards.length - 1]!;
      return;
    }
    const list = this.shadowRoot.getElementById('list');
    if (!list) return;
    for (const c of z.cards) {
      const el = document.createElement('zekel-card') as HTMLElement & { data: CardData };
      el.data = c;
      list.appendChild(el);
    }
  }
}

customElements.define('zekel-card-zone', ZekelCardZone);
