// <zekel-card> — one physical card. A div with a border-radius, a background,
// and text; face-down shows a back. Clicking emits zekel-select.

import { ZekelElement, esc, themeColor } from './base.js';

import type { CardData } from '@zekel/game-kit';
export type { CardData };

export class ZekelCard extends ZekelElement<CardData> {
  protected styles(): string {
    return `
      :host { display: inline-block; }
      .card {
        width: var(--zekel-card-w, 72px);
        height: var(--zekel-card-h, 100px);
        border-radius: 8px;
        border: 1.5px solid var(--zekel-card-border, #0006);
        padding: 6px 5px;
        display: flex; flex-direction: column; justify-content: space-between;
        cursor: pointer; user-select: none;
        box-shadow: 0 1px 3px #0003;
        font-size: 11px; line-height: 1.15; overflow: hidden;
        color: var(--zekel-card-text, #fff);
        text-shadow: 0 1px 2px #0008;
      }
      .card.down {
        background: repeating-linear-gradient(45deg, var(--zekel-card-back, #556), var(--zekel-card-back, #556) 6px, #0002 6px, #0002 12px);
        color: #fffc; text-align: center; justify-content: center;
      }
      .card.r90 { transform: rotate(90deg); }
      .card.r180 { transform: rotate(180deg); }
      .card.r270 { transform: rotate(270deg); }
      .label { font-weight: 600; overflow-wrap: break-word; }
      .badges { display: flex; flex-wrap: wrap; gap: 2px; }
      .badge { background: #0005; border-radius: 6px; padding: 0 4px; font-size: 9px; }
      .count { align-self: flex-end; font-weight: 700; }
    `;
  }

  protected template(c: CardData): string {
    const down = c.face === 'down';
    const cls = ['card', down ? 'down' : '', c.rotation ? `r${c.rotation}` : ''].join(' ');
    const style = down ? '' : `style="background:${themeColor(c.colorKey ?? c.label)}"`;
    const detail = JSON.stringify({ kind: 'card', id: c.id ?? null, label: c.label });
    return `
      <div class="${cls}" ${style} data-select='${esc(detail)}' title="${esc(c.label)}">
        <div class="label">${down ? esc(c.label || 'Face down') : esc(c.label)}</div>
        ${c.badges?.length ? `<div class="badges">${c.badges.map((b) => `<span class="badge">${esc(b)}</span>`).join('')}</div>` : ''}
        ${c.count && c.count > 1 ? `<div class="count">×${c.count}</div>` : ''}
      </div>`;
  }

  protected override render(): void {
    super.render();
    this.wireSelects();
  }
}

customElements.define('zekel-card', ZekelCard);
