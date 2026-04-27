/**
 * WikilinkSuggestionsPanel — panel #4 del Track A.
 *
 * Detecta strings en la nota activa que matchean títulos de OTRAS notas
 * pero no están linkeadas con `[[...]]`. Cada sugerencia tiene un botón
 * "Aplicar" que reemplaza el texto plano con el wikilink en vivo.
 *
 * Diferencia con LoopsPanel:
 *   - El panel NO solo muestra info — modifica la nota activa al click.
 *     Eso requiere acceso al `Editor` de Obsidian para hacer
 *     `editor.replaceRange()`.
 *   - El backend devuelve `char_offset` (offset absoluto en bytes desde
 *     el inicio del archivo), que el plugin convierte a posición del
 *     editor con `editor.offsetToPos()`.
 *
 * UX:
 *   - Reactive con triggers active-leaf-change + editor-modify
 *     (debounced 800ms — más alto que loops porque el LLM-free pero
 *     todavía cuesta ~50ms por scan + corpus-load del backend).
 *   - Card por sugerencia: título, target, context preview, botón "▶
 *     [[Aplicar]]".
 *   - Al aplicar: el cache del panel se invalida + el modify trigger
 *     re-fetch automáticamente, así la sugerencia desaparece de la
 *     lista cuando se aplicó (porque ahora SÍ está linkeada).
 *
 * Edge cases:
 *   - La nota cambió entre el fetch y el click: validamos que el path
 *     activo coincide con el source_path antes de aplicar. Si no, el
 *     handler abortar con un Notice "Cambiaste de nota — cancelo".
 *   - El offset ya no es válido (texto cambió): el `replaceRange`
 *     falla silencioso si el rango no matchea. Caso raro porque
 *     debounce 800ms cubre la mayoría.
 */
import { Notice, type Editor, type EditorPosition } from "obsidian";
import { BasePanel } from "./base";
import {
  type PanelContext,
  type PanelTrigger,
  type WikilinkSuggestion,
  type WikilinkSuggestionsResponse,
} from "../api/types";
import { LruCache } from "../api/cache";
import { t } from "../i18n";

export class WikilinkSuggestionsPanel extends BasePanel {
  readonly id = "wikilinks";
  readonly titleKey = "panel.wikilinks.title";
  readonly icon = "link";
  readonly triggers: PanelTrigger[] = ["active-leaf-change", "editor-modify"];
  readonly debounceMs = 800;

  private readonly cache = new LruCache<string, WikilinkSuggestionsResponse>({
    maxSize: 30,
    ttlMs: 30_000, // 30s — el panel re-fetchea con modify, no necesita TTL largo.
  });

  clearCache(): void {
    this.cache.clear();
  }

  protected loadingMessage(): string {
    return t("panel.wikilinks.loading");
  }

  protected async fetch(
    ctx: PanelContext,
  ): Promise<WikilinkSuggestionsResponse | null> {
    if (!ctx.file) return null;
    const path = ctx.file.path;
    // No usamos el cache cuando vienen de modify trigger, pero la API del
    // BasePanel no expone trigger info — invalidamos siempre por ahora.
    // Si el panel se vuelve costoso podemos pasar el trigger en
    // PanelContext en una iteración futura.
    this.cache.invalidate(path);
    const limit = Math.min(ctx.settings.topK * 3, 50);
    const resp = await ctx.backend.getWikilinkSuggestions(path, limit, {
      excludeFolders: ctx.settings.excludedFolders,
    });
    this.cache.set(path, resp);
    return resp;
  }

  protected isEmpty(data: unknown): boolean {
    if (!data) return true;
    const resp = data as WikilinkSuggestionsResponse;
    return Array.isArray(resp.items) && resp.items.length === 0;
  }

  protected renderEmpty(body: HTMLElement, ctx: PanelContext): void {
    if (!ctx.file) {
      body.createEl("div", {
        text: t("sidebar.empty"),
        cls: "rag-panel-empty",
      });
      return;
    }
    const cached = this.cache.get(ctx.file.path);
    let key = "panel.wikilinks.empty";
    if (cached?.reason === "empty_index") {
      key = "panel.wikilinks.empty.empty_index";
    } else if (cached?.reason === "not_found") {
      key = "panel.wikilinks.empty.not_found";
    }
    body.createEl("div", {
      text: t(key),
      cls: "rag-panel-empty rag-wikilinks-empty-clean",
    });
  }

  protected renderData(
    body: HTMLElement,
    data: unknown,
    ctx: PanelContext,
  ): void {
    const resp = data as WikilinkSuggestionsResponse;
    const list = body.createDiv({ cls: "rag-wikilinks-list" });
    for (const item of resp.items) {
      this.renderCard(list, item, ctx, resp.source_path);
    }
  }

  /**
   * Card layout:
   *
   *   ┌──────────────────────────────────────────────────┐
   *   │ Otra nota                          [▶ Aplicar]   │
   *   │ línea 5 · 02-Areas/Otra nota.md                  │
   *   │ "...habla de Otra nota sin linkearla..."          │
   *   └──────────────────────────────────────────────────┘
   */
  private renderCard(
    list: HTMLElement,
    item: WikilinkSuggestion,
    ctx: PanelContext,
    sourcePath: string,
  ): void {
    const card = list.createDiv({ cls: "rag-wikilinks-card" });

    // Header: title + apply button.
    const header = card.createDiv({ cls: "rag-wikilinks-header" });
    header.createSpan({
      text: item.title,
      cls: "rag-wikilinks-title",
    });
    const applyBtn = header.createEl("button", {
      text: t("panel.wikilinks.apply"),
      cls: "rag-wikilinks-apply",
    });
    applyBtn.addEventListener("click", (ev) => {
      ev.preventDefault();
      void this.applySuggestion(item, ctx, sourcePath, applyBtn);
    });

    // Meta: línea + path target. Click en el path → abrir nota destino.
    const meta = card.createDiv({ cls: "rag-wikilinks-meta" });
    meta.createSpan({
      text: `${t("panel.wikilinks.line")} ${item.line}`,
      cls: "rag-wikilinks-line",
    });
    meta.createSpan({ text: " · ", cls: "rag-wikilinks-sep" });
    const targetLink = meta.createEl("a", {
      text: item.target,
      cls: "rag-wikilinks-target",
    });
    targetLink.addEventListener("click", (ev) => {
      ev.preventDefault();
      const newPane = ev.metaKey || ev.ctrlKey;
      void ctx.openNote(item.target, { newPane });
    });

    // Context — preview ±60 chars. Highlight del title con <mark>.
    if (item.context) {
      const ctxEl = card.createDiv({ cls: "rag-wikilinks-context" });
      this.renderContextWithHighlight(ctxEl, item.context, item.title);
    }
  }

  /**
   * Renderea el context con el `title` resaltado. Sin DOM injection (el
   * context viene del server, podría tener chars HTML — usamos
   * createEl/createSpan en vez de innerHTML).
   */
  private renderContextWithHighlight(
    el: HTMLElement,
    context: string,
    title: string,
  ): void {
    el.empty();
    // Buscar la primera ocurrencia case-sensitive (el matching del
    // backend ya es case-sensitive así que es coherente).
    const idx = context.indexOf(title);
    if (idx < 0) {
      el.setText(context);
      return;
    }
    if (idx > 0) {
      el.createSpan({ text: context.slice(0, idx) });
    }
    el.createEl("mark", { text: title, cls: "rag-wikilinks-mark" });
    if (idx + title.length < context.length) {
      el.createSpan({ text: context.slice(idx + title.length) });
    }
  }

  /**
   * Handler del botón "Aplicar". Reemplaza el texto plano con el
   * wikilink usando el editor activo de Obsidian.
   *
   * Pasos:
   *   1. Verificar que la nota activa sigue siendo la source. Si el user
   *      cambió de nota mientras pensaba, abortar con Notice.
   *   2. Obtener el editor + convertir char_offset a EditorPosition.
   *   3. replaceRange con `[[title]]` desde offset hasta
   *      offset+title.length.
   *   4. Invalidar el cache + forzar re-render para que el card desaparezca.
   *
   * Edge case: si el offset ya no apunta al texto correcto (el user
   * editó), `replaceRange` reemplaza el rango pidiendo, lo que podría
   * romper texto. Validamos el contenido del rango antes de reemplazar.
   */
  private async applySuggestion(
    item: WikilinkSuggestion,
    ctx: PanelContext,
    sourcePath: string,
    btn: HTMLElement,
  ): Promise<void> {
    const activeFile = ctx.app.workspace.getActiveFile();
    if (!activeFile || activeFile.path !== sourcePath) {
      new Notice(t("panel.wikilinks.note_changed"));
      return;
    }
    const editor = ctx.app.workspace.activeEditor?.editor as Editor | undefined;
    if (!editor) {
      new Notice(t("panel.wikilinks.no_editor"));
      return;
    }

    // Convertir offset absoluto a posición editor (line, ch).
    let from: EditorPosition;
    let to: EditorPosition;
    try {
      from = editor.offsetToPos(item.char_offset);
      to = editor.offsetToPos(item.char_offset + item.title.length);
    } catch (err) {
      new Notice(t("panel.wikilinks.offset_invalid"));
      return;
    }

    // Validación: el texto en el rango debe ser igual al título. Si el
    // user editó la zona, abort en vez de romper texto válido.
    const currentText = editor.getRange(from, to);
    if (currentText !== item.title) {
      new Notice(
        `${t("panel.wikilinks.text_changed")}: "${currentText}" vs "${item.title}"`,
      );
      return;
    }

    // Aplicar el reemplazo.
    editor.replaceRange(`[[${item.title}]]`, from, to);

    // Feedback visual + invalidar cache para que el siguiente fetch
    // (modify trigger debounced) no traiga este item.
    btn.textContent = t("panel.wikilinks.applied");
    btn.setAttribute("disabled", "true");
    this.cache.invalidate(sourcePath);

    // Pequeño delay para que el user vea el feedback antes del re-render
    // (que va a quitar este card de la lista).
    setTimeout(() => {
      ctx.requestRerender();
    }, 200);
  }
}
