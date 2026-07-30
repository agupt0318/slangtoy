// The "what did Slang actually emit?" panel. The render tab shows the canvas;
// every other tab recompiles the current source for one more backend and shows
// the generated source.
//
// Slang gives one target per session, so each backend is its own compile. They
// are done on demand and cached per source revision to keep typing responsive.

import type { SlangCompiler } from './compiler';

const RENDER_TAB = 'render';
const TARGETS = ['WGSL', 'HLSL', 'GLSL', 'METAL'] as const;

export class Inspector {
  private active: string = RENDER_TAB;
  private source = '';
  private readonly cache = new Map<string, string>();

  constructor(
    private readonly tabsEl: HTMLElement,
    private readonly canvasHost: HTMLElement,
    private readonly outputEl: HTMLElement,
    private readonly compiler: SlangCompiler,
  ) {
    const available = compiler.availableTargets;
    const tabs = [RENDER_TAB, ...TARGETS.filter((t) => available.includes(t))];

    for (const tab of tabs) {
      const button = document.createElement('button');
      button.type = 'button';
      button.role = 'tab';
      button.dataset.tab = tab;
      button.textContent = tab === RENDER_TAB ? 'render' : tab.toLowerCase();
      button.addEventListener('click', () => this.select(tab));
      this.tabsEl.appendChild(button);
    }
    this.paint();
  }

  /** Called after every successful compile; invalidates the cached backends. */
  setSource(source: string): void {
    if (source === this.source) return;
    this.source = source;
    this.cache.clear();
    if (this.active !== RENDER_TAB) this.render();
  }

  private select(tab: string): void {
    this.active = tab;
    this.paint();
    if (tab === RENDER_TAB) return;
    this.render();
  }

  private paint(): void {
    for (const button of this.tabsEl.querySelectorAll('button')) {
      button.classList.toggle('is-active', button.dataset.tab === this.active);
    }
    const showingCode = this.active !== RENDER_TAB;
    this.outputEl.hidden = !showingCode;
    this.canvasHost.hidden = showingCode;
  }

  private render(): void {
    const target = this.active;
    const cached = this.cache.get(target);
    if (cached !== undefined) {
      this.outputEl.textContent = cached;
      return;
    }

    this.outputEl.textContent = `compiling for ${target.toLowerCase()}…`;
    // Let the placeholder paint before the compiler blocks the main thread.
    window.setTimeout(() => {
      if (this.active !== target) return;
      const result = this.compiler.compile(this.source, target);
      const text = result.ok
        ? result.wgsl
        : result.diagnostics.map((d) => (d.line ? `line ${d.line}: ` : '') + d.message).join('\n');
      this.cache.set(target, text);
      if (this.active === target) this.outputEl.textContent = text;
    }, 0);
  }
}
