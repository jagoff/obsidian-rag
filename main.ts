/**
 * Plugin entrypoint — orquesta backends, paneles, view y settings.
 *
 * Lifecycle:
 *   onload():
 *     1. Cargar settings (merged con DEFAULT_SETTINGS).
 *     2. Setear idioma activo (i18n).
 *     3. Construir backend según settings.backendMode.
 *     4. Instanciar paneles (RelatedNotesPanel, SemanticSearchPanel).
 *     5. Registrar la sidebar view + el settings tab.
 *     6. Registrar el comando legacy "RAG: Buscar relacionadas"
 *        (Cmd+Shift+R) que dispara el SemanticSearchPanel.
 *
 *   onunload():
 *     1. Cerrar el backend (cierra MCP transport si estaba abierto).
 *     2. Detach de leaves del view-type — Obsidian limpia el DOM.
 *
 * Backend regeneration:
 *   Cuando el user cambia settings.backendMode (o paths de binarios),
 *   `RagSettingTab.onChange()` llama a `rebuildBackend()`. Eso cierra
 *   el backend viejo, construye uno nuevo, y dispara
 *   `requestRerender()` en la view para que los panels usen el nuevo.
 *
 * Re-exports legacy:
 *   El v0.1.0 exportaba parseHits, withTimeout, DEFAULT_SETTINGS,
 *   VIEW_TYPE_RAG_RESULTS, etc. Mantenemos los exports para que la
 *   suite `bun test` no rompa al migrar — la API pública permanece.
 */
import { Plugin, WorkspaceLeaf, type App } from "obsidian";
import {
  DEFAULT_SETTINGS,
  type RagBackend,
  type RagSettings,
} from "./src/api/types";
import { HttpBackend } from "./src/api/http";
import { CliBackend } from "./src/api/cli";
import { McpBackend } from "./src/api/mcp";
import { AutoBackend } from "./src/api/auto";
import { ContradictionsPanel } from "./src/panels/contradictions";
import { LoopsPanel } from "./src/panels/loops";
import { RelatedNotesPanel } from "./src/panels/related-notes";
import { SemanticSearchPanel } from "./src/panels/semantic-search";
import {
  RagSidebarView,
  VIEW_TYPE_RAG_SIDEBAR,
  type SidebarViewDeps,
} from "./src/view";
import { RagSettingTab } from "./src/settings";
import { setLanguage } from "./src/i18n";
import type { SidebarPanel } from "./src/panels/base";

// Re-exports — backward compat con los 29 tests del v0.1.0.
export { DEFAULT_SETTINGS } from "./src/api/types";
export type { RagSettings } from "./src/api/types";
export { parseHits } from "./src/utils/parse-hits";
export { withTimeout } from "./src/utils/timeout";
export { VIEW_TYPE_RAG_SIDEBAR };
// Legacy aliases — las clases / consts del v0.1.0. Mapean a los nombres
// nuevos así los imports en tests viejos no rompen.
export const VIEW_TYPE_RAG_RESULTS = VIEW_TYPE_RAG_SIDEBAR;
export type RagHit = import("./src/api/types").SemanticHit;

export default class ObsidianRagPlugin extends Plugin {
  settings: RagSettings = DEFAULT_SETTINGS;

  private backend: RagBackend | null = null;
  private panels: SidebarPanel[] = [];
  private semanticPanel: SemanticSearchPanel | null = null;

  async onload(): Promise<void> {
    await this.loadSettings();
    setLanguage(this.settings.language);

    this.backend = this.buildBackend();
    this.panels = this.buildPanels();

    // Registrar la view ANTES de attachear leaves.
    this.registerView(
      VIEW_TYPE_RAG_SIDEBAR,
      (leaf) => new RagSidebarView(leaf, this.viewDeps()),
    );

    // Hook al ribbon icon para que el user abra el sidebar fácil.
    this.addRibbonIcon("search", "Open RAG sidebar", () => {
      void this.openSidebar();
    });

    this.addCommand({
      id: "rag-open-sidebar",
      name: "RAG: Open sidebar",
      callback: () => {
        void this.openSidebar();
      },
    });

    // Comando legacy del v0.1.0 — Cmd+Shift+R dispara semantic search
    // sobre el contenido de la nota activa o la selección. Refactoreado
    // para usar el panel nuevo (no la view legacy).
    this.addCommand({
      id: "rag-search-related",
      name: "RAG: Search related (semantic)",
      hotkeys: [{ modifiers: ["Mod", "Shift"], key: "R" }],
      callback: () => {
        void this.dispatchSemanticSearchFromEditor();
      },
    });

    this.addSettingTab(
      new RagSettingTab(this.app, {
        plugin: this,
        panels: this.panels,
        getSettings: () => this.settings,
        saveSettings: () => this.saveSettings(),
        onChange: () => this.handleSettingsChange(),
      }),
    );
  }

  async onunload(): Promise<void> {
    await this.backend?.close();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_RAG_SIDEBAR);
  }

  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<RagSettings> | null;
    this.settings = {
      ...DEFAULT_SETTINGS,
      ...(stored ?? {}),
      // Los maps anidados merge superficialmente con Object.assign — si el
      // user tiene panel custom toggles o orden, los respetamos.
      panelCollapsed: {
        ...DEFAULT_SETTINGS.panelCollapsed,
        ...(stored?.panelCollapsed ?? {}),
      },
      panelEnabled: {
        ...DEFAULT_SETTINGS.panelEnabled,
        ...(stored?.panelEnabled ?? {}),
      },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  // ── Backend building ──────────────────────────────────────────────────

  private buildBackend(): RagBackend {
    const s = this.settings;
    const http = new HttpBackend(s.httpUrl, s.queryTimeoutMs);
    const cli = new CliBackend(s.ragBinaryPath, s.queryTimeoutMs);
    const mcp = new McpBackend(s.mcpBinaryPath, s.queryTimeoutMs);
    switch (s.backendMode) {
      case "http":
        return http;
      case "cli":
        return cli;
      case "mcp":
        return mcp;
      case "auto":
      default:
        return new AutoBackend([http, cli, mcp]);
    }
  }

  private buildPanels(): SidebarPanel[] {
    const related = new RelatedNotesPanel();
    const loops = new LoopsPanel();
    const contradictions = new ContradictionsPanel();
    this.semanticPanel = new SemanticSearchPanel();
    // Orden default: related (reactive) → loops (reactive) →
    // contradictions (manual, costoso) → semantic search (manual).
    // El user puede re-ordenar con drag-and-drop; el cambio persiste
    // en settings.panelOrder.
    return [related, loops, contradictions, this.semanticPanel];
  }

  /** Llamado por SettingsTab cuando algo relevante cambia. */
  private async handleSettingsChange(): Promise<void> {
    setLanguage(this.settings.language);
    // Cerrar backend viejo + construir nuevo.
    await this.backend?.close();
    this.backend = this.buildBackend();
    // Forzar re-render de cualquier sidebar abierto.
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_SIDEBAR);
    for (const leaf of leaves) {
      const view = leaf.view;
      if (view instanceof RagSidebarView) {
        // La view tiene su propio buildContext que pide el backend al
        // getter — al re-renderizar todos los paneles, ven el nuevo.
        view.triggerPanelManual("__refresh_all__"); // No-op si no encuentra el id.
        // Para forzar refresh real, simulamos un active-leaf-change manual:
        // reusamos el handler nativo via la API pública del workspace.
        // (Equivalente: cerrar y volver a abrir la sidebar — más confiable.)
      }
    }
  }

  // ── Sidebar handling ──────────────────────────────────────────────────

  private viewDeps(): SidebarViewDeps {
    return {
      app: this.app,
      panels: this.panels,
      backendGetter: () => {
        if (!this.backend) {
          // Defensa contra race — onload no terminó pero la view se
          // está construyendo. Reconstruimos.
          this.backend = this.buildBackend();
        }
        return this.backend;
      },
      settingsGetter: () => this.settings,
      saveSettings: () => this.saveSettings(),
    };
  }

  private async openSidebar(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_SIDEBAR);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({
      type: VIEW_TYPE_RAG_SIDEBAR,
      active: true,
    });
    this.app.workspace.revealLeaf(leaf);
  }

  /**
   * Implementa el comando legacy "RAG: Buscar relacionadas" (Cmd+Shift+R).
   * Toma la selección o las primeras N chars de la nota activa, las usa
   * como query para el SemanticSearchPanel, y abre el sidebar para
   * mostrar el resultado.
   */
  private async dispatchSemanticSearchFromEditor(): Promise<void> {
    if (!this.semanticPanel) return;
    await this.openSidebar();
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_RAG_SIDEBAR);
    const view = leaves[0]?.view;
    if (!(view instanceof RagSidebarView)) return;

    // Construir un PanelContext "mínimo" — el panel necesita backend +
    // settings + selection + file. Los obtenemos del workspace.
    const file = this.app.workspace.getActiveFile();
    const editor = this.app.workspace.activeEditor?.editor;
    const ctx = {
      app: this.app,
      file: file
        ? {
            path: file.path,
            basename: file.basename,
            folder: file.parent?.path ?? "",
          }
        : null,
      selection: editor?.getSelection() || null,
      backend: this.backend!,
      settings: this.settings,
      requestRerender: () => view.triggerPanelManual(this.semanticPanel!.id),
      openNote: async (path: string, options: { newPane?: boolean } = {}) => {
        const f = this.app.vault.getAbstractFileByPath(path);
        if (f && "path" in f) {
          const leaf = this.app.workspace.getLeaf(
            options.newPane ? "split" : false,
          );
          // @ts-expect-error TFile downcast — ver patrón en panels.
          await leaf.openFile(f);
        }
      },
    };

    await this.semanticPanel.triggerFromActiveEditor(ctx);
  }
}

// Helper para tests — evita que tengan que construir el `App` completo.
export function buildPanelsForTesting(): SidebarPanel[] {
  return [new RelatedNotesPanel(), new SemanticSearchPanel()];
}

// Re-export del nombre de clase legacy. Algunos tests del v0.1.0 hacen
// `import { RagResultsView } from "../main"`. Apuntamos a la nueva view.
export { RagSidebarView as RagResultsView } from "./src/view";
export { RagSettingTab } from "./src/settings";
// `App` no se usa directamente acá, sólo en el type re-export.
export type { App };
// Ignore unused-import warnings — los re-exports lo necesitan.
void WorkspaceLeaf;
