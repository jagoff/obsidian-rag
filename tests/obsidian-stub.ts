// Runtime stub para `obsidian` — el paquete real solo trae .d.ts, así que
// los tests bajo bun necesitan un substitute. Mantenemos minimal: lo que
// el plugin (main.ts + src/**) realmente toca.
//
// Cambios v0.2.0 (cuando refactoreamos a sidebar extensible):
//  - Agregado `requestUrl` (HttpBackend lo usa).
//  - Agregado `setIcon` (RagSidebarView pinta chevrons + icons).
//  - Agregado `Menu`, `MenuItem` (RelatedNotesPanel context menu).
//  - Agregado `addToggle`, `addDropdown`, `addButton` al Setting (settings tab).
//  - `MockEl.createDiv` (Obsidian extiende HTMLElement con este helper —
//    los panels lo usan masivamente).

export interface MockEl {
  tagName: string;
  text: string;
  cls: string;
  children: MockEl[];
  listeners: Record<string, ((e: any) => void)[]>;
  attributes: Record<string, string>;
  draggable: boolean;
  classList: Set<string>;
  empty: () => void;
  createEl: (
    tag: string,
    opts?: {
      text?: string;
      cls?: string;
      attr?: Record<string, string>;
      type?: string;
    },
  ) => MockEl;
  createDiv: (opts?: { cls?: string; text?: string }) => MockEl;
  createSpan: (opts?: { cls?: string; text?: string; attr?: Record<string, string> }) => MockEl;
  appendChild: (child: MockEl) => void;
  addEventListener: (ev: string, fn: (e: any) => void) => void;
  removeEventListener: (ev: string, fn: (e: any) => void) => void;
  setText: (text: string) => void;
  setAttribute: (key: string, value: string) => void;
  removeAttribute: (key: string) => void;
  // Obsidian augments HTMLElement with these — replicamos el subset.
  addClass: (cls: string) => void;
  removeClass: (cls: string) => void;
  toggleClass: (cls: string, value?: boolean) => void;
  hasClass: (cls: string) => boolean;
  querySelector: (sel: string) => MockEl | null;
  contains: (other: MockEl) => boolean;
  // Test helpers.
  textContent: () => string;
  title: string;
  value: string;
}

export function makeEl(tag = "div"): MockEl {
  const el: MockEl = {
    tagName: tag,
    text: "",
    cls: "",
    children: [],
    listeners: {},
    attributes: {},
    classList: new Set(),
    draggable: false,
    title: "",
    value: "",
    empty() {
      el.children = [];
    },
    createEl(t, opts) {
      const child = makeEl(t);
      if (opts?.text) child.text = opts.text;
      if (opts?.cls) {
        child.cls = opts.cls;
        for (const c of opts.cls.split(/\s+/)) {
          if (c) child.classList.add(c);
        }
      }
      if (opts?.attr) {
        for (const [k, v] of Object.entries(opts.attr)) {
          child.attributes[k] = v;
        }
      }
      el.children.push(child);
      return child;
    },
    createDiv(opts) {
      return el.createEl("div", opts);
    },
    createSpan(opts) {
      return el.createEl("span", opts);
    },
    appendChild(child) {
      el.children.push(child);
    },
    addEventListener(ev, fn) {
      (el.listeners[ev] ??= []).push(fn);
    },
    removeEventListener(ev, fn) {
      if (!el.listeners[ev]) return;
      el.listeners[ev] = el.listeners[ev].filter((f) => f !== fn);
    },
    setText(text) {
      el.text = text;
    },
    setAttribute(key, value) {
      el.attributes[key] = value;
    },
    removeAttribute(key) {
      delete el.attributes[key];
    },
    addClass(c) {
      el.classList.add(c);
      el.cls = [...el.classList].join(" ");
    },
    removeClass(c) {
      el.classList.delete(c);
      el.cls = [...el.classList].join(" ");
    },
    toggleClass(c, value) {
      if (value === undefined) {
        if (el.classList.has(c)) el.classList.delete(c);
        else el.classList.add(c);
      } else if (value) el.classList.add(c);
      else el.classList.delete(c);
      el.cls = [...el.classList].join(" ");
    },
    hasClass(c) {
      return el.classList.has(c);
    },
    querySelector(sel) {
      // Simplified: solo soporta `.cls`.
      if (sel.startsWith(".")) {
        const cls = sel.slice(1);
        for (const child of el.children) {
          if (child.classList.has(cls)) return child;
          const nested = child.querySelector(sel);
          if (nested) return nested;
        }
      }
      return null;
    },
    contains(other) {
      if (el === other) return true;
      for (const c of el.children) {
        if (c.contains(other)) return true;
      }
      return false;
    },
    textContent() {
      const own = el.text;
      const kids = el.children.map((c) => c.textContent()).join(" ");
      return [own, kids].filter(Boolean).join(" ");
    },
  };
  return el;
}

// Global helper que Obsidian agrega a window — el code real lo usa via
// `createDiv(...)` top-level.
(globalThis as any).createDiv = (opts?: { cls?: string; text?: string }) =>
  makeEl().createDiv(opts);

// ── App / workspace / vault ─────────────────────────────────────────────

export class App {
  workspace: any = {
    activeEditor: null,
    getActiveFile: () => null,
    getLeavesOfType: () => [],
    getRightLeaf: () => null,
    revealLeaf: () => {},
    detachLeavesOfType: () => {},
    openLinkText: () => {},
    getLeaf: () => ({ openFile: async () => {}, setViewState: async () => {} }),
    on: (_ev: string, _fn: any) => ({ id: "ref" }),
    offref: (_ref: any) => {},
  };
  vault: any = {
    cachedRead: async () => "",
    getAbstractFileByPath: () => null,
    on: (_ev: string, _fn: any) => ({ id: "ref" }),
    offref: (_ref: any) => {},
  };
}

// ── Plugin / settings tab ───────────────────────────────────────────────

export class Plugin {
  app: App;
  private _stored: any = null;
  constructor(app: App, _manifest?: any) {
    this.app = app;
  }
  async loadData(): Promise<any> {
    return this._stored;
  }
  async saveData(d: any): Promise<void> {
    this._stored = d;
  }
  registerView(_t: string, _factory: (leaf: any) => any) {}
  addCommand(_c: any) {}
  addSettingTab(_t: any) {}
  addRibbonIcon(_i: string, _t: string, _cb: () => void) {}
  registerEvent(_ref: any) {}
}

export class PluginSettingTab {
  app: App;
  plugin: any;
  containerEl: MockEl = makeEl();
  constructor(app: App, plugin: any) {
    this.app = app;
    this.plugin = plugin;
  }
}

export class SettingTab extends PluginSettingTab {}

// ── Views ──────────────────────────────────────────────────────────────

export class ItemView {
  contentEl: MockEl = makeEl();
  leaf: any;
  constructor(leaf: any) {
    this.leaf = leaf;
  }
  registerEvent(_ref: any) {}
  getViewType(): string { return "stub"; }
  getDisplayText(): string { return "stub"; }
  getIcon(): string { return "search"; }
  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
  get app(): App {
    // En obsidian real, ItemView accede a app via `this.leaf.view.app`.
    // Para tests basta retornar una app dummy.
    return new App();
  }
}

// ── Setting (UI builder) ───────────────────────────────────────────────

export class Setting {
  // Records callbacks para que los tests puedan invocarlos como si el
  // user hubiera tipeado / clickeado.
  static lastChange: ((v: any) => any) | null = null;
  constructor(_container: MockEl) {}
  setName(_n: string) {
    return this;
  }
  setDesc(_d: string) {
    return this;
  }
  addText(fn: (t: TextComponent) => void) {
    const t = new TextComponent();
    fn(t);
    Setting.lastChange = t._onChange;
    return this;
  }
  addToggle(fn: (t: ToggleComponent) => void) {
    const t = new ToggleComponent();
    fn(t);
    Setting.lastChange = t._onChange;
    return this;
  }
  addDropdown(fn: (d: DropdownComponent) => void) {
    const d = new DropdownComponent();
    fn(d);
    Setting.lastChange = d._onChange;
    return this;
  }
  addButton(fn: (b: ButtonComponent) => void) {
    const b = new ButtonComponent();
    fn(b);
    return this;
  }
}

export class TextComponent {
  _value = "";
  _onChange: ((v: string) => any) | null = null;
  setPlaceholder(_p: string) { return this; }
  setValue(v: string) { this._value = v; return this; }
  onChange(fn: (v: string) => any) { this._onChange = fn; return this; }
}

export class ToggleComponent {
  _value = false;
  _onChange: ((v: boolean) => any) | null = null;
  setValue(v: boolean) { this._value = v; return this; }
  onChange(fn: (v: boolean) => any) { this._onChange = fn; return this; }
}

export class DropdownComponent {
  _value = "";
  _options: Record<string, string> = {};
  _onChange: ((v: string) => any) | null = null;
  addOptions(opts: Record<string, string>) {
    this._options = { ...this._options, ...opts };
    return this;
  }
  setValue(v: string) { this._value = v; return this; }
  onChange(fn: (v: string) => any) { this._onChange = fn; return this; }
}

export class ButtonComponent {
  _onClick: (() => any) | null = null;
  setButtonText(_t: string) { return this; }
  onClick(fn: () => any) { this._onClick = fn; return this; }
}

// ── Misc ────────────────────────────────────────────────────────────────

export const noticesShown: string[] = [];
export class Notice {
  constructor(msg: string) {
    noticesShown.push(msg);
  }
}

export class TFile {
  path = "";
  basename = "";
  parent: { path: string } | null = null;
  constructor(p?: string) {
    if (p) {
      this.path = p;
      this.basename = p.split("/").pop()?.replace(/\.md$/, "") ?? "";
      this.parent = { path: p.includes("/") ? p.split("/").slice(0, -1).join("/") : "" };
    }
  }
}

export class WorkspaceLeaf {
  view: any = null;
  async openFile(_f: TFile) {}
  async setViewState(_s: any) {}
}

// ── Menu / MenuItem (right-click menus) ─────────────────────────────────

export class MenuItem {
  _title = "";
  _icon = "";
  _onClick: (() => any) | null = null;
  setTitle(t: string) { this._title = t; return this; }
  setIcon(i: string) { this._icon = i; return this; }
  onClick(fn: () => any) { this._onClick = fn; return this; }
}

export class Menu {
  items: MenuItem[] = [];
  addItem(fn: (item: MenuItem) => void): this {
    const item = new MenuItem();
    fn(item);
    this.items.push(item);
    return this;
  }
  showAtMouseEvent(_ev: MouseEvent) {}
  showAtPosition(_pos: { x: number; y: number }) {}
}

// ── HTTP / icon helpers ─────────────────────────────────────────────────

export interface RequestUrlResponse {
  status: number;
  json: any;
  text: string;
  arrayBuffer: ArrayBuffer;
}

let _requestUrlImpl: (
  params: { url: string; method?: string; body?: string; headers?: any; throw?: boolean },
) => Promise<RequestUrlResponse> = async () => ({
  status: 503,
  json: null,
  text: "",
  arrayBuffer: new ArrayBuffer(0),
});

export function requestUrl(params: any) {
  return _requestUrlImpl(params);
}

/** Helper para tests: mockear la implementación de requestUrl. */
export function setRequestUrlMock(
  impl: typeof _requestUrlImpl,
): void {
  _requestUrlImpl = impl;
}

/** Helper para tests: resetear a default (siempre 503). */
export function resetRequestUrlMock(): void {
  _requestUrlImpl = async () => ({
    status: 503,
    json: null,
    text: "",
    arrayBuffer: new ArrayBuffer(0),
  });
}

export function setIcon(_el: any, _icon: string): void {
  // No-op en tests.
}
