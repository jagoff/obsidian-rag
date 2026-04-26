/**
 * RagSidebarView — el shell del sidebar derecho.
 *
 * Responsabilidades:
 *   - Renderizar un stack vertical de paneles (uno por SidebarPanel).
 *   - Cada panel tiene un header colapsable + body donde el panel
 *     dibuja su contenido. El header tiene: chevron, icon, título,
 *     refresh button, drag handle (para reorder).
 *   - Suscribirse a los workspace events (active-leaf-change,
 *     editor-modify) y disparar el render del panel correspondiente.
 *   - Persistir el estado collapsed + el orden de paneles en settings.
 *
 * Lo que NO hace:
 *   - Saber del dominio de cada panel (related notes, semantic search).
 *     Eso vive en `src/panels/*.ts`.
 *   - Instanciar backends. Los recibe via `backendGetter` del plugin —
 *     un getter porque el plugin puede regenerar el backend cuando el
 *     user cambia settings, y la view debe ver la nueva instance.
 *
 * Drag-and-drop reorder está implementado con HTML5 drag API nativo,
 * no Sortable.js — agregar 30KB al bundle por una feature de UX no vale.
 */
import {
  ItemView,
  type App,
  type EventRef,
  type WorkspaceLeaf,
  setIcon,
  TFile,
  Menu,
} from "obsidian";
import {
  type PanelContext,
  type PanelTrigger,
  type RagBackend,
  type RagSettings,
} from "./api/types";
import { type SidebarPanel } from "./panels/base";
import { debounce, type Debounced } from "./utils/debounce";
import { t } from "./i18n";

export const VIEW_TYPE_RAG_SIDEBAR = "obsidian-rag-sidebar";

export interface SidebarViewDeps {
  app: App;
  panels: SidebarPanel[];
  backendGetter: () => RagBackend;
  settingsGetter: () => RagSettings;
  saveSettings: () => Promise<void>;
}

interface PanelRuntime {
  panel: SidebarPanel;
  /** Wrapper colapsable + header + body — el container completo del panel. */
  container: HTMLElement;
  /** Body donde el panel.render() escribe. */
  body: HTMLElement;
  /** Header arrastrable. */
  header: HTMLElement;
  /** Debounce wrapper para el modify trigger (si el panel está suscripto). */
  debouncedRender: Debounced<() => void> | null;
}

export class RagSidebarView extends ItemView {
  private readonly deps: SidebarViewDeps;
  private readonly runtimes: Map<string, PanelRuntime> = new Map();
  private workspaceEventRef: EventRef | null = null;
  private vaultEventRef: EventRef | null = null;

  constructor(leaf: WorkspaceLeaf, deps: SidebarViewDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string {
    return VIEW_TYPE_RAG_SIDEBAR;
  }

  getDisplayText(): string {
    return t("sidebar.view_title");
  }

  getIcon(): string {
    return "search";
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass("rag-sidebar-view");
    this.renderShell();
    this.registerWorkspaceListeners();
    // Render inicial: si hay nota activa, dispara active-leaf-change-style.
    void this.renderAllPanels();
  }

  async onClose(): Promise<void> {
    this.unregisterListeners();
    for (const rt of this.runtimes.values()) {
      rt.debouncedRender?.cancel();
      try {
        await rt.panel.onClose?.();
      } catch {
        // Best-effort cleanup.
      }
    }
    this.runtimes.clear();
  }

  // ── Renderizado del shell ─────────────────────────────────────────────

  /**
   * Crea el DOM inicial: una empty-state al fondo + cada panel con su
   * header colapsable + body. El orden viene de settings.panelOrder; los
   * paneles registrados que no estén ahí van al final.
   */
  private renderShell(): void {
    const root = this.contentEl;
    root.empty();

    const settings = this.deps.settingsGetter();
    const orderedIds = this.computeOrderedIds(settings.panelOrder);

    for (const id of orderedIds) {
      const panel = this.deps.panels.find((p) => p.id === id);
      if (!panel) continue;
      // Si el panel está disabled en settings, no creamos su DOM.
      if (settings.panelEnabled[id] === false) continue;
      const rt = this.createPanelRuntime(panel);
      this.runtimes.set(id, rt);
      root.appendChild(rt.container);
    }

    if (this.runtimes.size === 0) {
      root.createEl("div", {
        text: t("sidebar.empty"),
        cls: "rag-sidebar-empty-shell",
      });
    }
  }

  /** Combina settings.panelOrder + panels registrados (los nuevos al final). */
  private computeOrderedIds(savedOrder: string[]): string[] {
    const registeredIds = this.deps.panels.map((p) => p.id);
    const seen = new Set<string>();
    const result: string[] = [];
    for (const id of savedOrder) {
      if (registeredIds.includes(id) && !seen.has(id)) {
        result.push(id);
        seen.add(id);
      }
    }
    for (const id of registeredIds) {
      if (!seen.has(id)) {
        result.push(id);
        seen.add(id);
      }
    }
    return result;
  }

  /**
   * Crea el DOM de un panel: container > header (chevron + icon + title +
   * refresh button + drag handle) + body. Engancha listeners de collapse,
   * refresh, drag-and-drop reorder.
   */
  private createPanelRuntime(panel: SidebarPanel): PanelRuntime {
    const settings = this.deps.settingsGetter();
    const collapsed = settings.panelCollapsed[panel.id] ?? false;

    const container = createDiv({ cls: "rag-panel" });
    if (collapsed) container.addClass("rag-panel-collapsed");
    container.setAttribute("data-panel-id", panel.id);
    container.draggable = true;

    const header = container.createDiv({ cls: "rag-panel-header" });
    // Chevron expandible — toggleClass en lugar de re-render del shell.
    const chevron = header.createSpan({ cls: "rag-panel-chevron" });
    setIcon(chevron, collapsed ? "chevron-right" : "chevron-down");

    // Icon del panel.
    const iconEl = header.createSpan({ cls: "rag-panel-icon" });
    setIcon(iconEl, panel.icon);

    // Título — i18n key.
    header.createSpan({
      text: t(panel.titleKey),
      cls: "rag-panel-title",
    });

    // Refresh button al final.
    const refresh = header.createSpan({
      cls: "rag-panel-refresh",
      attr: { "aria-label": t("sidebar.refresh") },
    });
    setIcon(refresh, "refresh-cw");
    refresh.addEventListener("click", (ev) => {
      ev.stopPropagation();
      void this.renderPanel(panel.id);
    });

    const body = container.createDiv({ cls: "rag-panel-body" });

    // Click en el header (no refresh) → toggle collapsed.
    header.addEventListener("click", (ev) => {
      // No togglear si el click vino del refresh button o sus hijos.
      if (
        ev.target instanceof HTMLElement &&
        (ev.target === refresh || refresh.contains(ev.target))
      ) {
        return;
      }
      void this.togglePanelCollapsed(panel.id);
    });

    // Drag-and-drop reorder — implementado simple: dragstart guarda el
    // id en dataTransfer, dragover en otro panel marca el target,
    // dragend / drop reordena el array de settings + re-renderiza.
    container.addEventListener("dragstart", (ev) => {
      ev.dataTransfer?.setData("text/plain", panel.id);
      container.addClass("rag-panel-dragging");
    });
    container.addEventListener("dragend", () => {
      container.removeClass("rag-panel-dragging");
      // Limpieza defensiva — algunos browsers no disparan dragleave.
      for (const rt of this.runtimes.values()) {
        rt.container.removeClass("rag-panel-drag-target");
      }
    });
    container.addEventListener("dragover", (ev) => {
      ev.preventDefault();
      container.addClass("rag-panel-drag-target");
    });
    container.addEventListener("dragleave", () => {
      container.removeClass("rag-panel-drag-target");
    });
    container.addEventListener("drop", (ev) => {
      ev.preventDefault();
      container.removeClass("rag-panel-drag-target");
      const draggedId = ev.dataTransfer?.getData("text/plain");
      if (!draggedId || draggedId === panel.id) return;
      void this.reorderPanels(draggedId, panel.id);
    });

    // Setup debounced render para modify trigger, si aplica.
    const debouncedRender = panel.triggers.includes("editor-modify")
      ? debounce(() => {
          void this.renderPanel(panel.id);
        }, panel.debounceMs ?? 400)
      : null;

    return { panel, container, body, header, debouncedRender };
  }

  // ── Render orchestration ──────────────────────────────────────────────

  /** Re-render todos los paneles en paralelo. Usado en init. */
  private async renderAllPanels(): Promise<void> {
    await Promise.all(
      [...this.runtimes.keys()].map((id) => this.renderPanel(id)),
    );
  }

  /**
   * Re-render un panel específico. NO toca otros — útil para refresh
   * button + para modify-trigger debounced que no querés que afecte
   * otros paneles.
   */
  private async renderPanel(panelId: string): Promise<void> {
    const rt = this.runtimes.get(panelId);
    if (!rt) return;
    // Si está colapsado, igual ejecutamos render — el body ya está hidden
    // pero el cache del panel se mantiene fresco para cuando se expanda.
    // Trade-off: 1 fetch innecesario vs UX peor al expandir (loading spinner).
    // Preferimos pagar el fetch.
    const ctx = this.buildContext();
    try {
      await rt.panel.render(ctx, rt.body);
    } catch (err) {
      // panel.render YA captura sus propios errores via BasePanel — pero
      // por defensiveness atrapamos cualquier throw que escape.
      // eslint-disable-next-line no-console
      console.error(`[obsidian-rag] panel ${panelId} render error:`, err);
    }
  }

  /** Construye el PanelContext para esta render pass. */
  private buildContext(): PanelContext {
    const file = this.app.workspace.getActiveFile();
    let fileMeta: PanelContext["file"] = null;
    if (file instanceof TFile) {
      fileMeta = {
        path: file.path,
        basename: file.basename,
        folder: file.parent?.path ?? "",
      };
    }
    const editor = this.app.workspace.activeEditor?.editor;
    const selection = editor?.getSelection() || null;

    return {
      app: this.app,
      file: fileMeta,
      selection,
      backend: this.deps.backendGetter(),
      settings: this.deps.settingsGetter(),
      requestRerender: () => {
        void this.renderAllPanels();
      },
      openNote: this.openNote.bind(this),
    };
  }

  // ── State management ──────────────────────────────────────────────────

  private async togglePanelCollapsed(panelId: string): Promise<void> {
    const rt = this.runtimes.get(panelId);
    if (!rt) return;
    const settings = this.deps.settingsGetter();
    const wasCollapsed = settings.panelCollapsed[panelId] ?? false;
    settings.panelCollapsed[panelId] = !wasCollapsed;
    await this.deps.saveSettings();
    rt.container.toggleClass("rag-panel-collapsed", !wasCollapsed);
    const chevron = rt.header.querySelector(".rag-panel-chevron");
    if (chevron instanceof HTMLElement) {
      setIcon(chevron, wasCollapsed ? "chevron-down" : "chevron-right");
    }
  }

  private async reorderPanels(
    draggedId: string,
    targetId: string,
  ): Promise<void> {
    const settings = this.deps.settingsGetter();
    const order = this.computeOrderedIds(settings.panelOrder);
    const fromIdx = order.indexOf(draggedId);
    const toIdx = order.indexOf(targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    order.splice(fromIdx, 1);
    order.splice(toIdx, 0, draggedId);
    settings.panelOrder = order;
    await this.deps.saveSettings();
    // Re-renderizar el shell completo — los nodos se reordenan en el DOM.
    // Mantenemos los runtimes para no perder el body cacheado.
    const root = this.contentEl;
    root.empty();
    for (const id of order) {
      const rt = this.runtimes.get(id);
      if (rt) root.appendChild(rt.container);
    }
  }

  // ── Workspace events ──────────────────────────────────────────────────

  private registerWorkspaceListeners(): void {
    this.workspaceEventRef = this.app.workspace.on(
      "active-leaf-change",
      () => {
        void this.handleActiveLeafChange();
      },
    );
    this.vaultEventRef = this.app.vault.on("modify", (file) => {
      // Solo si la modificación es en la nota activa, disparamos el
      // modify-trigger (con debounce). No queremos refrescar cuando el
      // user editó otra nota en split-pane.
      const active = this.app.workspace.getActiveFile();
      if (active && file === active) {
        this.fireTrigger("editor-modify");
      }
    });
    this.registerEvent(this.workspaceEventRef);
    this.registerEvent(this.vaultEventRef);
  }

  private unregisterListeners(): void {
    if (this.workspaceEventRef) {
      this.app.workspace.offref(this.workspaceEventRef);
      this.workspaceEventRef = null;
    }
    if (this.vaultEventRef) {
      this.app.vault.offref(this.vaultEventRef);
      this.vaultEventRef = null;
    }
  }

  private async handleActiveLeafChange(): Promise<void> {
    this.fireTrigger("active-leaf-change");
  }

  /** Dispara el render de los paneles suscriptos al trigger. */
  private fireTrigger(trigger: PanelTrigger): void {
    for (const rt of this.runtimes.values()) {
      if (!rt.panel.triggers.includes(trigger)) continue;
      if (trigger === "editor-modify" && rt.debouncedRender) {
        rt.debouncedRender();
      } else {
        void this.renderPanel(rt.panel.id);
      }
    }
  }

  // ── Utilities expuestas al PanelContext ───────────────────────────────

  private async openNote(
    path: string,
    options: { newPane?: boolean } = {},
  ): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return;
    const leaf = this.app.workspace.getLeaf(options.newPane ? "split" : false);
    await leaf.openFile(file);
  }

  // ── Hook público para SemanticSearchPanel ─────────────────────────────
  //
  // Cuando el user dispara el comando "Buscar relacionadas" (Cmd+Shift+R)
  // desde el plugin, queremos forzar el render del panel "semantic-search"
  // aunque no esté en su trigger natural. Exponemos esto para que el
  // plugin core pueda llamarnos sin hackear via DOM.
  triggerPanelManual(panelId: string): void {
    void this.renderPanel(panelId);
  }
}

// Nota: `createDiv` top-level es un global agregado por Obsidian
// (declarado en obsidian.d.ts línea 193 dentro de `declare global`).
// En runtime existe en window. En tests, el stub lo shimea via
// `tests/obsidian-stub.ts`. No agregamos un `declare global` propio
// acá porque colisionaría con el del paquete `obsidian`.
