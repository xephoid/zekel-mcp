// Shared plumbing for the zekel-* component library (docs/board-viz.md).
// HTML/CSS only — no SVG anywhere in the library (Zeke's rule; a game that
// truly needs drawing declares a game-local custom component instead).
//
// Conventions every component follows:
//   - data in via the `data` property (a plain object; setting it re-renders)
//   - theming via CSS custom properties: any `colorKey` resolves as
//     var(--zekel-c-<slug>, <stable hashed fallback>) so an unthemed board is
//     still legible and a game theme is just a stylesheet
//   - interaction out via bubbling, composed `zekel-select` CustomEvents with
//     { component, id, label, ...extras } detail — the board host decides
//     what a click means (usually: prefill the move builder)

export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

/** Stable hashed HSL so unthemed keys still get distinct, consistent colors. */
export function fallbackColor(key: string): string {
  let h = 0;
  for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360}, 50%, 62%)`;
}

/** CSS color expression for a theme key: themed via --zekel-c-<slug>, hashed fallback. */
export function themeColor(key: string): string {
  return `var(--zekel-c-${slug(key)}, ${fallbackColor(key)})`;
}

/** The base styles every component's shadow root starts with. */
export const BASE_CSS = `
  :host { display: block; font-family: system-ui, sans-serif; color: var(--zekel-text, inherit); }
  * { box-sizing: border-box; }
  .zone-label { font-size: 12px; font-weight: 600; opacity: 0.75; margin: 0 0 4px; }
  button { font: inherit; }
`;

export abstract class ZekelElement<T> extends HTMLElement {
  #data: T | null = null;

  get data(): T | null {
    return this.#data;
  }

  set data(value: T | null) {
    this.#data = value;
    this.render();
  }

  connectedCallback(): void {
    if (!this.shadowRoot) this.attachShadow({ mode: 'open' });
    this.render();
  }

  protected render(): void {
    if (!this.shadowRoot) return;
    const d = this.#data;
    this.shadowRoot.innerHTML = `<style>${BASE_CSS}${this.styles()}</style>${d === null ? '' : this.template(d)}`;
  }

  protected abstract styles(): string;
  protected abstract template(data: T): string;

  /** Emit the library's standard interaction event. */
  protected select(detail: Record<string, unknown>): void {
    this.dispatchEvent(
      new CustomEvent('zekel-select', { bubbles: true, composed: true, detail: { component: this.tagName.toLowerCase(), ...detail } }),
    );
  }

  /** Wire click → select on everything carrying data-select (JSON detail). */
  protected wireSelects(): void {
    this.shadowRoot?.querySelectorAll<HTMLElement>('[data-select]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        this.select(JSON.parse(el.dataset.select!));
      });
    });
  }
}
