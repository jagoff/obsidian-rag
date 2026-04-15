import {
  App,
  ItemView,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface RagSettings {
  binaryPath: string;
  queryTimeoutMs: number;
  topK: number;
}

export const DEFAULT_SETTINGS: RagSettings = {
  binaryPath: "/Users/fer/.local/bin/obsidian-rag-mcp",
  queryTimeoutMs: 30_000,
  topK: 5,
};

export const VIEW_TYPE_RAG_RESULTS = "obsidian-rag-results";

export interface RagHit {
  path: string;
  note: string;
  score: number;
  content: string;
  folder?: string;
  tags?: string[];
}

export default class ObsidianRagPlugin extends Plugin {
  settings: RagSettings = DEFAULT_SETTINGS;
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  async onload() {
    await this.loadSettings();

    this.registerView(
      VIEW_TYPE_RAG_RESULTS,
      (leaf) => new RagResultsView(leaf, this),
    );

    this.addCommand({
      id: "rag-search-related",
      name: "RAG: Buscar notas relacionadas",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "R" }],
      callback: () => this.searchRelated(),
    });

    this.addSettingTab(new RagSettingTab(this.app, this));
  }

  async onunload() {
    await this.closeMcp();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RAG_RESULTS);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StdioClientTransport({
      command: this.settings.binaryPath,
      args: [],
    });
    const client = new Client(
      { name: "obsidian-rag-plugin", version: "0.1.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.transport = transport;
    this.client = client;
    return client;
  }

  private async closeMcp() {
    try {
      await this.client?.close();
    } catch {}
    try {
      await this.transport?.close();
    } catch {}
    this.client = null;
    this.transport = null;
  }

  private async searchRelated() {
    const query = await this.getQueryFromActiveEditor();
    if (!query) {
      new Notice("Nada para buscar: seleccioná texto o abrí una nota.");
      return;
    }
    await this.revealResultsView();
    const view = this.getResultsView();
    view?.setLoading(query);

    try {
      const hits = await this.runQuery(query);
      view?.renderHits(query, hits);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      view?.renderError(query, msg);
      new Notice(`RAG error: ${msg}`);
    }
  }

  private async getQueryFromActiveEditor(): Promise<string | null> {
    const editor = this.app.workspace.activeEditor?.editor;
    if (editor) {
      const sel = editor.getSelection().trim();
      if (sel) return sel;
    }
    const file = this.app.workspace.getActiveFile();
    if (!file) return null;
    const content = await this.app.vault.cachedRead(file);
    return content.slice(0, 4000).trim() || null;
  }

  private async runQuery(question: string): Promise<RagHit[]> {
    const client = await this.ensureClient();
    const timeoutMs = this.settings.queryTimeoutMs;
    const resp = await withTimeout(
      client.callTool({
        name: "rag_query",
        arguments: { question, k: this.settings.topK },
      }),
      timeoutMs,
      `MCP rag_query >${timeoutMs}ms`,
    );
    return parseHits(resp);
  }

  private async revealResultsView() {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_RESULTS);
    if (existing.length) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_RAG_RESULTS, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private getResultsView(): RagResultsView | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_RESULTS);
    const view = leaves[0]?.view;
    return view instanceof RagResultsView ? view : null;
  }

  async openNote(path: string) {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(file);
      return;
    }
    new Notice(`No se encontró la nota: ${path}`);
  }
}

export function parseHits(resp: unknown): RagHit[] {
  const content = (resp as { content?: Array<{ type: string; text?: string }> })
    ?.content;
  if (!Array.isArray(content)) return [];
  const textBlock = content.find((c) => c.type === "text" && c.text);
  if (!textBlock?.text) return [];
  try {
    const parsed = JSON.parse(textBlock.text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((h: any) => ({
      path: String(h.path ?? h.file ?? ""),
      note: String(h.note ?? h.path ?? ""),
      score: Number(h.score ?? h.rerank_score ?? 0),
      content: String(h.content ?? h.text ?? ""),
      folder: h.folder,
      tags: Array.isArray(h.tags) ? h.tags : undefined,
    }));
  } catch {
    return [];
  }
}

export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export class RagResultsView extends ItemView {
  constructor(leaf: WorkspaceLeaf, private plugin: ObsidianRagPlugin) {
    super(leaf);
  }

  getViewType() {
    return VIEW_TYPE_RAG_RESULTS;
  }
  getDisplayText() {
    return "RAG";
  }
  getIcon() {
    return "search";
  }

  async onOpen() {
    this.renderEmpty();
  }

  renderEmpty() {
    const root = this.contentEl;
    root.empty();
    root.createEl("div", {
      text: "Ejecutá “RAG: Buscar notas relacionadas” (Cmd+Shift+R).",
      cls: "rag-empty",
    });
  }

  setLoading(query: string) {
    const root = this.contentEl;
    root.empty();
    root.createEl("div", { text: `Buscando: ${query.slice(0, 120)}…`, cls: "rag-loading" });
  }

  renderError(query: string, msg: string) {
    const root = this.contentEl;
    root.empty();
    root.createEl("h4", { text: "Error" });
    root.createEl("div", { text: `Query: ${query.slice(0, 200)}` });
    root.createEl("pre", { text: msg });
  }

  renderHits(query: string, hits: RagHit[]) {
    const root = this.contentEl;
    root.empty();
    const header = root.createEl("div", { cls: "rag-header" });
    header.createEl("div", { text: `Query: ${query.slice(0, 200)}`, cls: "rag-query" });
    header.createEl("div", { text: `${hits.length} resultados`, cls: "rag-count" });

    if (!hits.length) {
      root.createEl("div", { text: "Sin hits relevantes.", cls: "rag-empty" });
      return;
    }

    const list = root.createEl("div", { cls: "rag-hits" });
    for (const hit of hits) {
      const card = list.createEl("div", { cls: "rag-hit" });
      const title = card.createEl("a", {
        text: hit.note || hit.path,
        cls: "rag-hit-title",
      });
      title.addEventListener("click", (ev) => {
        ev.preventDefault();
        this.plugin.openNote(hit.path);
      });
      card.createEl("div", {
        text: `score ${hit.score.toFixed(3)}${hit.folder ? ` · ${hit.folder}` : ""}`,
        cls: "rag-hit-meta",
      });
      const snippet = hit.content.slice(0, 400);
      card.createEl("div", { text: snippet, cls: "rag-hit-snippet" });
    }
  }
}

export class RagSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: ObsidianRagPlugin) {
    super(app, plugin);
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Ruta al binario obsidian-rag-mcp")
      .setDesc("Path absoluto al ejecutable del MCP server.")
      .addText((text) =>
        text
          .setPlaceholder("/Users/…/.local/bin/obsidian-rag-mcp")
          .setValue(this.plugin.settings.binaryPath)
          .onChange(async (v) => {
            this.plugin.settings.binaryPath = v.trim();
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName("Timeout de query (ms)")
      .setDesc("Máximo para cada llamada a rag_query.")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.queryTimeoutMs))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isFinite(n) && n > 0) {
              this.plugin.settings.queryTimeoutMs = n;
              await this.plugin.saveSettings();
            }
          }),
      );

    new Setting(containerEl)
      .setName("Resultados por query (top-k)")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.topK))
          .onChange(async (v) => {
            const n = Number(v);
            if (Number.isInteger(n) && n > 0 && n <= 15) {
              this.plugin.settings.topK = n;
              await this.plugin.saveSettings();
            }
          }),
      );
  }
}
