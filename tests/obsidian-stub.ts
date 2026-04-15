// Runtime stub for the `obsidian` module — the real package ships only
// .d.ts files, so anything that imports from "obsidian" needs a runtime
// substitute under bun test. Kept minimal: only what main.ts touches.

export interface MockEl {
  tagName: string;
  text: string;
  cls: string;
  children: MockEl[];
  listeners: Record<string, ((e: any) => void)[]>;
  empty: () => void;
  createEl: (tag: string, opts?: { text?: string; cls?: string }) => MockEl;
  addEventListener: (ev: string, fn: (e: any) => void) => void;
  // Convenience for tests: depth-first text dump.
  textContent: () => string;
}

export function makeEl(tag = "div"): MockEl {
  const el: MockEl = {
    tagName: tag,
    text: "",
    cls: "",
    children: [],
    listeners: {},
    empty() {
      el.children = [];
    },
    createEl(t, opts) {
      const child = makeEl(t);
      if (opts?.text) child.text = opts.text;
      if (opts?.cls) child.cls = opts.cls;
      el.children.push(child);
      return child;
    },
    addEventListener(ev, fn) {
      (el.listeners[ev] ??= []).push(fn);
    },
    textContent() {
      const own = el.text;
      const kids = el.children.map((c) => c.textContent()).join(" ");
      return [own, kids].filter(Boolean).join(" ");
    },
  };
  return el;
}

export class App {
  workspace: any = {
    activeEditor: null,
    getActiveFile: () => null,
    getLeavesOfType: () => [],
    getRightLeaf: () => null,
    revealLeaf: () => {},
    detachLeavesOfType: () => {},
    openLinkText: () => {},
    getLeaf: () => ({ openFile: async () => {} }),
  };
  vault: any = {
    cachedRead: async () => "",
    getAbstractFileByPath: () => null,
  };
}

export class Plugin {
  app: App;
  // Tests inject these via constructor; loadData/saveData simulate Obsidian persistence.
  private _stored: any = null;
  constructor(app: App) {
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

export class ItemView {
  contentEl: MockEl = makeEl();
  leaf: any;
  constructor(leaf: any) {
    this.leaf = leaf;
  }
}

export class Setting {
  // Records callbacks so tests can invoke them like the user typed in the field.
  static lastChange: ((v: string) => any) | null = null;
  constructor(_container: MockEl) {}
  setName(_n: string) {
    return this;
  }
  setDesc(_d: string) {
    return this;
  }
  addText(fn: (text: TextComponent) => void) {
    const t = new TextComponent();
    fn(t);
    Setting.lastChange = t._onChange;
    return this;
  }
}

export class TextComponent {
  _value = "";
  _onChange: ((v: string) => any) | null = null;
  setPlaceholder(_p: string) {
    return this;
  }
  setValue(v: string) {
    this._value = v;
    return this;
  }
  onChange(fn: (v: string) => any) {
    this._onChange = fn;
    return this;
  }
}

export const noticesShown: string[] = [];
export class Notice {
  constructor(msg: string) {
    noticesShown.push(msg);
  }
}

export class TFile {
  path = "";
  constructor(p?: string) {
    if (p) this.path = p;
  }
}

export class WorkspaceLeaf {
  view: any = null;
}
