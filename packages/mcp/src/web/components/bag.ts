// <zekel-bag> — a push-your-luck chip bag: a drawstring-bag figure with a count, optional known composition
// as chips, the pulled reveal row, and a status flag (drawing/busted/halted).

import { ZekelElement, esc, themeColor } from './base.js';
import type { CardData } from './card.js';

import type { BagData } from '@zekel/game-kit';
export type { BagData };

export class ZekelBag extends ZekelElement<BagData> {
  protected styles(): string {
    return `
      .wrap { display: flex; gap: 10px; align-items: flex-start; flex-wrap: wrap; }
      .bag {
        width: 64px; height: 72px; position: relative; text-align: center;
        background: var(--zekel-bag, #7a5c3e);
        border-radius: 14% 14% 46% 46% / 8% 8% 60% 60%;
        border: 2px solid #0005;
        display: flex; align-items: center; justify-content: center;
        color: #fff; font-weight: 700; font-size: 15px; text-shadow: 0 1px 2px #000a;
      }
      .bag::before {
        content: ''; position: absolute; top: -7px; left: 18%; right: 18%;
        height: 10px; background: inherit; border: 2px solid #0005; border-radius: 40%;
      }
      .status { font-size: 11px; font-weight: 700; text-transform: uppercase;
        border-radius: 8px; padding: 1px 8px; display: inline-block; margin-top: 4px;
        background: var(--zekel-status, #8884); }
      .status.busted { background: #c33; color: #fff; }
      .status.halted { background: #c90; color: #fff; }
      .chips { display: flex; flex-wrap: wrap; gap: 4px; max-width: 260px; }
      .chip { border-radius: 50%; width: 34px; height: 34px; border: 2px solid #0006;
        display: flex; align-items: center; justify-content: center;
        font-size: 9px; color: #fff; text-shadow: 0 1px 2px #000b; text-align: center;
        cursor: pointer; overflow: hidden; }
      .chip b { font-size: 11px; }
      .reveal { display: flex; gap: 4px; align-items: center; }
      .reveal .zone-label { margin: 0 4px 0 0; }
      .pulled { display: flex; gap: 4px; flex-wrap: wrap; }
    `;
  }

  protected template(b: BagData): string {
    const total = b.contents ? b.contents.reduce((a, c) => a + c.count, 0) : (b.count ?? 0);
    const chips = (b.contents ?? [])
      .map((c) => {
        const detail = JSON.stringify({ kind: 'chip', label: c.label });
        return `<span class="chip" style="background:${themeColor(c.colorKey ?? c.label)}"
          data-select='${esc(detail)}' title="${esc(c.label)} ×${c.count}">${c.count > 1 ? `<b>${c.count}</b>` : esc(c.label.slice(0, 4))}</span>`;
      })
      .join('');
    const pulled = (b.revealRow ?? [])
      .map((c) => {
        const detail = JSON.stringify({ kind: 'pulled-chip', id: c.id ?? null, label: c.label });
        return `<span class="chip" style="background:${themeColor(c.colorKey ?? c.label)}"
          data-select='${esc(detail)}' title="${esc(c.label)}">${esc(c.label.slice(0, 4))}</span>`;
      })
      .join('');
    return `
      ${b.label ? `<div class="zone-label">${esc(b.label)}</div>` : ''}
      <div class="wrap">
        <div>
          <div class="bag" title="${total} in the bag">${total}</div>
          ${b.status ? `<div class="status ${esc(b.status)}">${esc(b.status)}</div>` : ''}
        </div>
        ${chips ? `<div><div class="zone-label">contents</div><div class="chips">${chips}</div></div>` : ''}
        ${pulled ? `<div><div class="zone-label">pulled</div><div class="pulled">${pulled}</div></div>` : ''}
      </div>`;
  }

  protected override render(): void {
    super.render();
    this.wireSelects();
  }
}

customElements.define('zekel-bag', ZekelBag);
