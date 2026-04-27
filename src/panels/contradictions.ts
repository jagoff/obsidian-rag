/**
 * ContradictionsPanel — panel #3 del sidebar (Track A del roadmap).
 *
 * Muestra fragmentos de OTRAS notas del vault que contradicen
 * afirmaciones de la nota activa. Power feature único — ningún otro
 * plugin de Obsidian hace esto.
 *
 * Diferencias con RelatedNotesPanel:
 *   - NO reactive (active-leaf-change). Detectar contradicciones usa el
 *     chat LLM (command-r/qwen2.5) — 5-10s por call. Dispararlo
 *     automáticamente al cambiar de nota rompería UX + quemaría batería.
 *     El panel es MANUAL: el user clickea refresh cuando quiere re-calcular.
 *   - Cache 30 min por path (vs 60s del related). Las contradicciones no
 *     cambian tan rápido, y recomputar cuesta ~10× más.
 *   - Empty states distintos según `reason`:
 *       - "too_short": body < 200 chars → pedir más prosa.
 *       - "not_indexed"/"not_found": correr `rag index`.
 *       - "empty_index": correr `rag index` la primera vez.
 *       - null + items=[]: no hay contradicciones (lo bueno).
 *
 * UX:
 *   - Estado inicial: panel colapsado + texto "click refresh para analizar".
 *     NO disparamos fetch hasta que el user lo pida.
 *   - Durante fetch: loading con disclaimer "(puede tardar ~10s)".
 *   - Cards: título clickeable + `why` del LLM en prominente + snippet en gris.
 *   - Right-click: abrir / abrir split / copiar wikilink.
 */
import { Menu as ObsidianMenu, type Menu, type MenuItem } from "obsidian";
import { BasePanel } from "./base";
import {
  type ContradictionItem,
  type ContradictionsResponse,
  type PanelContext,
  type PanelTrigger,
} from "../api/types";
import { LruCache } from "../api/cache";
import { t } from "../i18n";

export class ContradictionsPanel extends BasePanel {
  readonly id = "contradictions";
  readonly titleKey = "panel.contradictions.title";
  readonly icon = "alert-triangle";
  readonly triggers: PanelTrigger[] = ["manual"];

  // Cache 30 min — las contradicciones no cambian hasta que:
  //   (a) el user modifica la nota activa (invalidar on vault.modify),
  //   (b) el user agrega nuevas notas al vault (en teoría tendríamos que
  //       invalidar pero es costoso tracker; 30 min es compromiso
  //       razonable).
  private readonly cache = new LruCache<string, ContradictionsResponse>({
    maxSize: 30,
    ttlMs: 30 * 60 * 1000,
  });

  clearCache(): void {
    this.cache.clear();
  }

  // Track del primer open — sabemos si el user ya miró este panel. Si
  // no lo miró, arrancamos colapsado (le evitamos el loading automático
  // del BasePanel que dispararía el LLM).
  private _hasInitialized = false;

  protected loadingMessage(): string {
    return t("panel.contradictions.loading");
  }

  /**
   * Override del render — queremos controlar el primer open (no disparar
   * el LLM sin que el user lo pida explícitamente).
   */
  async render(ctx: PanelContext, body: HTMLElement): Promise<void> {
    if (!ctx.file) {
      body.empty();
      body.createEl("div", {
        text: t("sidebar.empty"),
        cls: "rag-panel-empty",
      });
      return;
    }

    // Si hay cache para esta nota, la mostramos instant. Reuso el render
    // default (loading → fetch → renderData) que va a hit el cache.
    const cached = this.cache.get(ctx.file.path);
    if (cached) {
      body.empty();
      if (cached.items.length === 0) {
        this.renderEmpty(body, ctx);
      } else {
        this.renderData(body, cached, ctx);
      }
      return;
    }

    // Primer open sin cache: estado "idle" con un call-to-action.
    // Evita el trigger automático del BasePanel.render que llamaría al
    // LLM sin que el user lo pida.
    if (!this._hasInitialized) {
      body.empty();
      const idle = body.createDiv({ cls: "rag-panel-empty rag-contradictions-idle" });
      idle.createEl("div", { text: t("panel.contradictions.idle") });
      const btn = idle.createEl("button", {
        text: t("panel.contradictions.idle_action"),
        cls: "rag-btn rag-contradictions-start",
      });
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        this._hasInitialized = true;
        void this.runFetch(ctx, body);
      });
      return;
    }

    // Segunda vez en adelante: el user ya pidió análisis alguna vez.
    // Asumimos que quiere re-analizar (llegamos acá desde refresh
    // button) → ejecutar el flow base.
    await this.runFetch(ctx, body);
  }

  /** Forzar re-fetch + render — llamado desde el idle button y el refresh. */
  private async runFetch(ctx: PanelContext, body: HTMLElement): Promise<void> {
    this.renderLoading(body);
    try {
      const data = await this.fetch(ctx);
      if (!data) {
        this.renderEmpty(body, ctx);
        return;
      }
      const resp = data as ContradictionsResponse;
      if (ctx.file) {
        this.cache.set(ctx.file.path, resp);
      }
      body.empty();
      if (resp.items.length === 0) {
        this.renderEmpty(body, ctx);
      } else {
        this.renderData(body, resp, ctx);
      }
    } catch (err) {
      this.renderError(body, err);
    }
  }

  protected async fetch(
    ctx: PanelContext,
  ): Promise<ContradictionsResponse | null> {
    if (!ctx.file) return null;
    const limit = Math.min(ctx.settings.topK, 10);
    return await ctx.backend.getContradictions(ctx.file.path, limit, {
      excludeFolders: ctx.settings.excludedFolders,
    });
  }

  protected renderEmpty(body: HTMLElement, ctx: PanelContext): void {
    body.empty();
    if (!ctx.file) {
      body.createEl("div", {
        text: t("sidebar.empty"),
        cls: "rag-panel-empty",
      });
      return;
    }
    // Distinguimos por reason (cacheado en la última response) —
    // accionable para el user.
    const cached = this.cache.get(ctx.file.path);
    let key = "panel.contradictions.empty";
    if (cached?.reason === "empty_index") {
      key = "panel.contradictions.empty.empty_index";
    } else if (cached?.reason === "not_indexed" || cached?.reason === "not_found") {
      key = "panel.contradictions.empty.not_indexed";
    } else if (cached?.reason === "too_short") {
      key = "panel.contradictions.empty.too_short";
    }
    body.createEl("div", { text: t(key), cls: "rag-panel-empty" });
  }

  protected renderData(
    body: HTMLElement,
    data: unknown,
    ctx: PanelContext,
  ): void {
    const resp = data as ContradictionsResponse;
    const list = body.createDiv({ cls: "rag-contradictions-list" });
    for (const item of resp.items) {
      this.renderCard(list, item, ctx);
    }
  }

  /**
   * Card por item. Layout:
   *
   *   ┌───────────────────────────────────────────────────┐
   *   │ ⚠  Nota vecina                                     │
   *   │    Por qué: <razón LLM en 1-2 líneas>              │
   *   │    <snippet del fragmento en gris, ~280 chars>     │
   *   └───────────────────────────────────────────────────┘
   */
  private renderCard(
    list: HTMLElement,
    item: ContradictionItem,
    ctx: PanelContext,
  ): void {
    const card = list.createDiv({ cls: "rag-contradictions-card" });

    // Title row con icon de warning + note name.
    const titleRow = card.createDiv({ cls: "rag-contradictions-title-row" });
    titleRow.createSpan({ text: "⚠", cls: "rag-contradictions-icon" });
    const title = titleRow.createEl("a", {
      text: item.note || item.path,
      cls: "rag-contradictions-title",
    });
    title.addEventListener("click", (ev) => {
      ev.preventDefault();
      const newPane = ev.metaKey || ev.ctrlKey;
      void ctx.openNote(item.path, { newPane });
    });
    title.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.showContextMenu(ev, item, ctx);
    });

    // Folder breadcrumb.
    if (item.folder) {
      card.createDiv({
        text: item.folder,
        cls: "rag-contradictions-folder",
      });
    }

    // Why — la señal más valiosa. La hacemos prominente.
    if (item.why) {
      const why = card.createDiv({ cls: "rag-contradictions-why" });
      why.createSpan({
        text: t("panel.contradictions.why_prefix"),
        cls: "rag-contradictions-why-prefix",
      });
      why.createSpan({ text: " " + item.why });
    }

    // Snippet — en gris, contexto secundario.
    if (item.snippet) {
      card.createDiv({
        text: item.snippet,
        cls: "rag-contradictions-snippet",
      });
    }
  }

  private showContextMenu(
    ev: MouseEvent,
    item: ContradictionItem,
    ctx: PanelContext,
  ): void {
    const menu = new ObsidianMenu();
    this.buildContextMenu(menu, item, ctx);
    menu.showAtMouseEvent(ev);
  }

  private buildContextMenu(
    menu: Menu,
    item: ContradictionItem,
    ctx: PanelContext,
  ): void {
    menu.addItem((mi: MenuItem) =>
      mi
        .setTitle(t("panel.related.menu.open"))
        .setIcon("file")
        .onClick(() => {
          void ctx.openNote(item.path);
        }),
    );
    menu.addItem((mi: MenuItem) =>
      mi
        .setTitle(t("panel.related.menu.open_split"))
        .setIcon("layout-grid")
        .onClick(() => {
          void ctx.openNote(item.path, { newPane: true });
        }),
    );
    menu.addItem((mi: MenuItem) =>
      mi
        .setTitle(t("panel.related.menu.copy_link"))
        .setIcon("link")
        .onClick(() => {
          const link = `[[${item.note || item.path}]]`;
          void navigator.clipboard.writeText(link);
        }),
    );
  }
}
