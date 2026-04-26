/**
 * SidebarPanel — contrato que cumple cada panel del sidebar.
 *
 * El plugin core no sabe nada sobre el dominio de cada panel; sólo lo
 * registra, lo orquesta (triggers + render) y le da el `PanelContext`.
 * Eso permite que agregar un panel nuevo sea: crear el archivo en
 * `src/panels/foo.ts`, exportar la clase, registrarla en `main.ts:onload`,
 * agregar el id al `DEFAULT_SETTINGS.panelOrder`.
 *
 * Cada panel maneja:
 *   - Su propio fetch (recibe el backend del context).
 *   - Su propio render (recibe un `HTMLElement` body donde dibuja).
 *   - Su propio loading/error/empty states.
 *
 * El shell del sidebar maneja:
 *   - El header colapsable (con título + botón refresh + chevron).
 *   - El estado collapsed (persistido en settings).
 *   - El drag-and-drop reorder.
 *   - Los triggers (active-leaf-change / editor-modify / manual).
 */
import type { PanelContext, PanelTrigger } from "../api/types";

export interface SidebarPanel {
  /** Identificador estable. Va en settings.panelOrder y panelCollapsed. */
  readonly id: string;

  /** Título visible en el header (i18n key, no string suelto). */
  readonly titleKey: string;

  /** Lucide icon name para el header. Ver https://lucide.dev/. */
  readonly icon: string;

  /**
   * Triggers a los que el panel se suscribe. La view orquesta el fetch
   * + render cuando uno se dispara. "manual" significa que el panel se
   * pone en estado idle hasta que el user clickee el refresh button.
   */
  readonly triggers: PanelTrigger[];

  /**
   * Debounce ms para el trigger "editor-modify". Ignorado para los otros
   * triggers (que disparan instantly). Default 400.
   */
  readonly debounceMs?: number;

  /**
   * Llamado cuando el panel se debe re-fetch + re-render. La
   * implementación es responsable de su propio loading/error states
   * dentro del `body` que recibe.
   *
   * El panel NO debe asumir que `ctx.file` no sea null — para nota
   * vacía / no-file abierto debe pintar empty state explícito.
   */
  render(ctx: PanelContext, body: HTMLElement): Promise<void>;

  /**
   * Cleanup llamado cuando el panel se destruye (view onClose, plugin
   * unload). Default no-op — sólo override si abriste timers, listeners,
   * o conexiones de red persistentes que necesitás cerrar.
   */
  onClose?(): Promise<void> | void;

  /**
   * Renderiza la UI de settings específica del panel debajo del settings
   * tab principal. Opcional — la mayoría de los panels se configuran via
   * el settings global (top-k, idioma).
   */
  renderSettings?(containerEl: HTMLElement): void;
}

/**
 * Helper concreto para casos comunes — panels que sólo necesitan loading,
 * error, empty, success states.
 *
 * Subclase mínima:
 *   class MyPanel extends BasePanel {
 *     readonly id = "my-panel";
 *     readonly titleKey = "panel.my.title";
 *     readonly icon = "search";
 *     readonly triggers = ["active-leaf-change"];
 *
 *     async fetch(ctx) { return await ctx.backend.getRelated(...); }
 *     renderEmpty(body) { body.createEl("div", { text: "vacío" }); }
 *     renderData(body, data) { for (const item of data.items) ... }
 *   }
 */
export abstract class BasePanel implements SidebarPanel {
  abstract readonly id: string;
  abstract readonly titleKey: string;
  abstract readonly icon: string;
  abstract readonly triggers: PanelTrigger[];
  readonly debounceMs?: number;

  /** Override: hace el fetch al backend y devuelve la data lista para render. */
  protected abstract fetch(ctx: PanelContext): Promise<unknown>;

  /** Override: renderiza el estado de "no data". */
  protected abstract renderEmpty(
    body: HTMLElement,
    ctx: PanelContext,
  ): void;

  /** Override: renderiza la data devuelta por fetch(). */
  protected abstract renderData(
    body: HTMLElement,
    data: unknown,
    ctx: PanelContext,
  ): void;

  /**
   * Loading state default. Subclase puede override si quiere algo más
   * elaborado (skeleton cards, etc.).
   */
  protected renderLoading(body: HTMLElement): void {
    body.empty();
    body.createEl("div", {
      text: this.loadingMessage(),
      cls: "rag-panel-loading",
    });
  }

  /** Override para loading message custom (i18n recomendado). */
  protected loadingMessage(): string {
    return "...";
  }

  /**
   * Error state default. La view captura cualquier throw y delega a esto.
   */
  protected renderError(
    body: HTMLElement,
    err: unknown,
  ): void {
    body.empty();
    const div = body.createEl("div", { cls: "rag-panel-error" });
    div.createEl("div", {
      text: "Error",
      cls: "rag-panel-error-title",
    });
    div.createEl("pre", {
      text: err instanceof Error ? err.message : String(err),
      cls: "rag-panel-error-detail",
    });
  }

  /**
   * Render orchestrator que llama a renderLoading → fetch → renderData
   * o renderError. La view llama a esto, no a fetch / render direct.
   */
  async render(ctx: PanelContext, body: HTMLElement): Promise<void> {
    this.renderLoading(body);
    try {
      const data = await this.fetch(ctx);
      if (this.isEmpty(data)) {
        body.empty();
        this.renderEmpty(body, ctx);
        return;
      }
      body.empty();
      this.renderData(body, data, ctx);
    } catch (err) {
      this.renderError(body, err);
    }
  }

  /**
   * Heuristica default — override para shapes específicas (ej. {items:[]}
   * o objetos custom).
   */
  protected isEmpty(data: unknown): boolean {
    if (!data) return true;
    if (Array.isArray(data) && data.length === 0) return true;
    if (
      typeof data === "object" &&
      data !== null &&
      "items" in data &&
      Array.isArray((data as { items: unknown[] }).items) &&
      (data as { items: unknown[] }).items.length === 0
    ) {
      return true;
    }
    return false;
  }
}
