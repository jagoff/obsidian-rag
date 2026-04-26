/**
 * SemanticSearchPanel — refactor del feature único del v0.1.0.
 *
 * Diferencias con RelatedNotesPanel:
 *   - Manual trigger (no se dispara automáticamente al cambiar de
 *     nota). El user lo activa con el comando "RAG: Buscar
 *     relacionadas" (Cmd+Shift+R) o con un botón dentro del panel.
 *   - Usa retrieve+rerank (rag_query MCP), no find_related — la query
 *     puede ser un párrafo, una pregunta, o el texto completo de la
 *     nota activa. find_related solo opera por shared tags + grafo.
 *   - Renderiza chunks de markdown (snippets de 400 chars), no notas
 *     enteras.
 *
 * Por qué semantic-search vive en el sidebar como panel y no como
 * comando standalone:
 *   - El user pidió "el sidebar va a tener varios paneles, pensemos en
 *     ese contexto desde el día 1".
 *   - Reusar la infra de la view (refresh, collapse, settings) en vez
 *     de crear una segunda view-type para una sola feature.
 *   - Habilita combinar "buscar lo que escribí" + "ver mis notas
 *     relacionadas" en una sola pantalla.
 */
import { Notice } from "obsidian";
import { BasePanel } from "./base";
import {
  type PanelContext,
  type PanelTrigger,
  type SemanticHit,
} from "../api/types";
import { t } from "../i18n";

/**
 * State persistido en la instance del panel — entre renders mantenemos
 * el último query disparado y los hits para no perder el resultado al
 * cambiar de nota (a diferencia de RelatedNotes que cachea por path,
 * éste cachea por session global).
 */
interface SemanticState {
  query: string | null;
  hits: SemanticHit[] | null;
  loading: boolean;
  error: string | null;
}

export class SemanticSearchPanel extends BasePanel {
  readonly id = "semantic-search";
  readonly titleKey = "panel.semantic.title";
  readonly icon = "search";
  // Manual trigger: solo refresh-button o invocación externa via command.
  readonly triggers: PanelTrigger[] = ["manual"];

  private state: SemanticState = {
    query: null,
    hits: null,
    loading: false,
    error: null,
  };

  protected loadingMessage(): string {
    return t("panel.semantic.loading");
  }

  /**
   * Override completo del render del BasePanel — necesitamos tomar
   * control para mostrar el input + action buttons + estado, en lugar
   * del flujo loading→fetch→render del base.
   */
  async render(ctx: PanelContext, body: HTMLElement): Promise<void> {
    body.empty();

    // ── Toolbar: input + buttons ───────────────────────────────────
    const toolbar = body.createDiv({ cls: "rag-semantic-toolbar" });
    const input = toolbar.createEl("input", {
      type: "text",
      cls: "rag-semantic-input",
      attr: { placeholder: t("panel.semantic.placeholder") },
    });
    if (this.state.query) input.value = this.state.query;

    const submit = (): void => {
      const query = input.value.trim();
      if (!query) return;
      void this.runQuery(ctx, query, body);
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        submit();
      }
    });

    const actions = toolbar.createDiv({ cls: "rag-semantic-actions" });
    const useSelectionBtn = actions.createEl("button", {
      text: t("panel.semantic.action_use_selection"),
      cls: "rag-semantic-action",
    });
    useSelectionBtn.addEventListener("click", () => {
      const sel = ctx.selection?.trim();
      if (!sel) {
        new Notice(t("panel.semantic.action_use_selection") + ": —");
        return;
      }
      input.value = sel.slice(0, 200);
      void this.runQuery(ctx, sel, body);
    });

    const useNoteBtn = actions.createEl("button", {
      text: t("panel.semantic.action_use_note"),
      cls: "rag-semantic-action",
    });
    useNoteBtn.addEventListener("click", async () => {
      if (!ctx.file) {
        new Notice(t("sidebar.empty"));
        return;
      }
      const file = ctx.app.vault.getAbstractFileByPath(ctx.file.path);
      if (!file || !("path" in file)) return;
      try {
        // cachedRead es el método correcto para leer texto de TFile
        // (vault.read también funciona pero hace I/O sin cache).
        const fullContent = await ctx.app.vault.cachedRead(
          // @ts-expect-error TFile en runtime, pero `obsidian` types
          // no admiten downcast desde TAbstractFile sin instanceof guard.
          file,
        );
        const trimmed = fullContent.slice(0, 4000).trim();
        if (!trimmed) return;
        input.value = trimmed.slice(0, 200);
        void this.runQuery(ctx, trimmed, body);
      } catch (err) {
        new Notice(`Error leyendo nota: ${String(err)}`);
      }
    });

    // ── Body: results / loading / error / empty ────────────────────
    const results = body.createDiv({ cls: "rag-semantic-results" });
    if (this.state.loading) {
      results.createEl("div", {
        text: t("panel.semantic.loading"),
        cls: "rag-panel-loading",
      });
      return;
    }
    if (this.state.error) {
      results.createEl("div", {
        text: this.state.error,
        cls: "rag-panel-error",
      });
      return;
    }
    if (this.state.hits === null) {
      // Nunca buscamos nada todavía — empty state ligero.
      results.createEl("div", {
        text: t("panel.semantic.empty"),
        cls: "rag-panel-empty",
      });
      return;
    }
    if (this.state.hits.length === 0) {
      results.createEl("div", {
        text: t("panel.semantic.empty"),
        cls: "rag-panel-empty",
      });
      return;
    }
    this.renderHits(results, this.state.hits, ctx);
  }

  // BasePanel infra que no usamos (override completo de render arriba),
  // pero TypeScript exige que estén implementadas porque son abstract.
  protected async fetch(_ctx: PanelContext): Promise<unknown> {
    return null;
  }
  protected renderEmpty(_body: HTMLElement, _ctx: PanelContext): void {
    /* unused */
  }
  protected renderData(
    _body: HTMLElement,
    _data: unknown,
    _ctx: PanelContext,
  ): void {
    /* unused */
  }

  /**
   * Hook expuesto al plugin — el comando "RAG: Buscar relacionadas"
   * (Cmd+Shift+R) usa la selección o el contenido de la nota como query
   * y dispara este método. La view luego renderea el panel reflejando el
   * nuevo estado.
   */
  async triggerFromActiveEditor(ctx: PanelContext): Promise<void> {
    let query: string | null = null;
    if (ctx.selection?.trim()) {
      query = ctx.selection.trim();
    } else if (ctx.file) {
      const file = ctx.app.vault.getAbstractFileByPath(ctx.file.path);
      if (file && "path" in file) {
        try {
          // @ts-expect-error TFile downcast — ver comentario en useNoteBtn.
          const content = await ctx.app.vault.cachedRead(file);
          query = content.slice(0, 4000).trim() || null;
        } catch {
          query = null;
        }
      }
    }
    if (!query) {
      new Notice(t("sidebar.empty"));
      return;
    }
    // Re-renderizamos el panel con el nuevo state.
    this.state.query = query;
    this.state.loading = true;
    ctx.requestRerender();
    try {
      const hits = await ctx.backend.semanticSearch(query, ctx.settings.topK);
      this.state.hits = hits;
      this.state.loading = false;
      this.state.error = null;
    } catch (err) {
      this.state.hits = null;
      this.state.loading = false;
      this.state.error = err instanceof Error ? err.message : String(err);
    }
    ctx.requestRerender();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private async runQuery(
    ctx: PanelContext,
    query: string,
    body: HTMLElement,
  ): Promise<void> {
    this.state.query = query;
    this.state.loading = true;
    this.state.error = null;
    // Re-renderizar el panel para mostrar loading inmediatamente.
    await this.render(ctx, body);
    try {
      const hits = await ctx.backend.semanticSearch(query, ctx.settings.topK);
      this.state.hits = hits;
      this.state.loading = false;
    } catch (err) {
      this.state.hits = null;
      this.state.loading = false;
      this.state.error = err instanceof Error ? err.message : String(err);
    }
    await this.render(ctx, body);
  }

  private renderHits(
    container: HTMLElement,
    hits: SemanticHit[],
    ctx: PanelContext,
  ): void {
    const list = container.createDiv({ cls: "rag-semantic-list" });
    for (const hit of hits) {
      const card = list.createDiv({ cls: "rag-semantic-card" });
      const title = card.createEl("a", {
        text: hit.note || hit.path,
        cls: "rag-semantic-title",
      });
      title.addEventListener("click", (ev) => {
        ev.preventDefault();
        const newPane = ev.metaKey || ev.ctrlKey;
        void ctx.openNote(hit.path, { newPane });
      });
      const meta = card.createDiv({ cls: "rag-semantic-meta" });
      meta.setText(
        `score ${hit.score.toFixed(2)}${hit.folder ? ` · ${hit.folder}` : ""}`,
      );
      const snippet = hit.content.slice(0, 400);
      card.createEl("div", { text: snippet, cls: "rag-semantic-snippet" });
    }
  }
}
