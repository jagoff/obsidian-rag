/**
 * RelatedNotesPanel — primer panel del sidebar.
 *
 * Muestra notas relacionadas a la activa por shared tags + graph hops
 * (find_related en el backend). Reactive: re-fetch en cada
 * active-leaf-change. NO se suscribe a editor-modify por defecto porque
 * find_related opera sobre el corpus indexado, y el corpus no se
 * actualiza hasta que `rag watch` reindexa la nota — un debounce de 5
 * segundos mientras tipeás no aporta nada.
 *
 * UI:
 *   - Cards verticales: título (clickeable), breadcrumb del folder,
 *     badge con la razón, score, chips de tags compartidos.
 *   - Hover: tooltip con preview (lo dejamos como TODO — necesita
 *     leer el archivo y eso es 1 round-trip extra).
 *   - Right-click: menú nativo de Obsidian con "Abrir" / "Abrir en
 *     split" / "Copiar wikilink".
 */
import { type Menu, type MenuItem, Menu as ObsidianMenu } from "obsidian";
import { BasePanel } from "./base";
import {
  type PanelContext,
  type PanelTrigger,
  type RelatedItem,
  type RelatedResponse,
} from "../api/types";
import { LruCache } from "../api/cache";
import { t } from "../i18n";

// Mapping reason → CSS class, así el styles.css puede colorear cada uno
// distinto. Mantener los keys sincronizados con types.ts:RelatedItem.reason.
const REASON_CLASSES: Record<RelatedItem["reason"], string> = {
  link: "rag-related-reason-link",
  tags: "rag-related-reason-tags",
  "tags+link": "rag-related-reason-both",
};

export class RelatedNotesPanel extends BasePanel {
  readonly id = "related-notes";
  readonly titleKey = "panel.related.title";
  readonly icon = "git-pull-request-arrow";
  readonly triggers: PanelTrigger[] = ["active-leaf-change"];

  // Cache de respuestas por path. TTL corto (60s) — cuando el user vuelve
  // a la nota dentro de la misma sesión rápida, evitamos un fetch.
  // Invalidamos manualmente cuando vault.modify dispara — la view nos
  // pasa el ctx con un file fresco; podríamos llamar a invalidate(path)
  // si quisiéramos refresh forzado en cada modify, pero hoy preferimos
  // cache simple porque find_related solo cambia tras reindex.
  private readonly cache = new LruCache<string, RelatedResponse>({
    maxSize: 50,
    ttlMs: 60_000,
  });

  clearCache(): void {
    this.cache.clear();
  }

  protected loadingMessage(): string {
    return t("panel.related.loading");
  }

  protected async fetch(ctx: PanelContext): Promise<RelatedResponse | null> {
    if (!ctx.file) return null;
    const path = ctx.file.path;
    const cached = this.cache.get(path);
    if (cached) return cached;
    const limit = ctx.settings.topK;
    const resp = await ctx.backend.getRelated(path, limit, {
      excludeFolders: ctx.settings.excludedFolders,
    });
    this.cache.set(path, resp);
    return resp;
  }

  /**
   * Override del isEmpty default — un RelatedResponse con items vacío
   * pero `reason: "empty_index"` o `"not_indexed"` debe mostrar empty
   * state distinto al "0 items por nota muy huérfana".
   */
  protected isEmpty(data: unknown): boolean {
    if (!data) return true;
    const resp = data as RelatedResponse;
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
    // Para distinguir el por qué del empty, intentamos mirar el cache
    // (que tiene la última response con reason). Si el reason es
    // empty_index / not_indexed, mostramos un mensaje accionable.
    const cached = this.cache.get(ctx.file.path);
    let key = "panel.related.empty";
    if (cached?.reason === "empty_index") {
      key = "panel.related.empty.empty_index";
    } else if (cached?.reason === "not_indexed") {
      key = "panel.related.empty.not_indexed";
    }
    body.createEl("div", { text: t(key), cls: "rag-panel-empty" });
  }

  protected renderData(
    body: HTMLElement,
    data: unknown,
    ctx: PanelContext,
  ): void {
    const resp = data as RelatedResponse;
    const list = body.createDiv({ cls: "rag-related-list" });
    for (const item of resp.items) {
      this.renderCard(list, item, ctx);
    }
  }

  /**
   * Card por item. Layout:
   *
   *   ┌───────────────────────────────────────┐
   *   │ Note Title                           │
   *   │ folder/breadcrumb · score · reason   │
   *   │ #shared-tag-1  #shared-tag-2          │  (only si shared_tags > 0)
   *   └───────────────────────────────────────┘
   */
  private renderCard(
    list: HTMLElement,
    item: RelatedItem,
    ctx: PanelContext,
  ): void {
    const card = list.createDiv({ cls: "rag-related-card" });

    // Título — clickeable. Usamos <a> en lugar de <button> porque
    // semánticamente apunta a una nota (link), y se ve más natural en el
    // theme de Obsidian (var(--text-accent), underline on hover).
    const title = card.createEl("a", {
      text: item.note || item.path,
      cls: "rag-related-title",
    });
    title.addEventListener("click", (ev) => {
      ev.preventDefault();
      // Cmd/Ctrl + click → split-pane.
      const newPane = ev.metaKey || ev.ctrlKey;
      void ctx.openNote(item.path, { newPane });
    });
    title.addEventListener("contextmenu", (ev) => {
      ev.preventDefault();
      this.showContextMenu(ev, item, ctx);
    });

    // Meta line: folder · score · reason badge.
    const meta = card.createDiv({ cls: "rag-related-meta" });
    if (item.folder) {
      meta.createSpan({
        text: item.folder,
        cls: "rag-related-folder",
      });
      meta.createSpan({ text: " · ", cls: "rag-related-sep" });
    }
    meta.createSpan({
      text: String(item.score),
      cls: "rag-related-score",
    });
    meta.createSpan({ text: " · ", cls: "rag-related-sep" });
    const reasonBadge = meta.createSpan({
      text: t(`panel.related.reason.${item.reason}`),
      cls: `rag-related-reason ${REASON_CLASSES[item.reason]}`,
    });
    // Para hover-tooltip explicativo: por qué este score y este reason.
    reasonBadge.title = this.explainReason(item);

    // Shared tags chips — solo si hay overlap. Skippeamos cuando
    // McpBackend devolvió shared_tags=[] (no tiene la noción).
    if (item.shared_tags.length > 0) {
      const chips = card.createDiv({ cls: "rag-related-chips" });
      for (const tag of item.shared_tags) {
        chips.createSpan({
          text: `#${tag}`,
          cls: "rag-related-chip",
        });
      }
    }
  }

  private explainReason(item: RelatedItem): string {
    // Tooltip hover — útil para que el user entienda los puntajes sin
    // necesidad de leer docs. Texto en el idioma activo via i18n no
    // hace falta acá: la composición es tan corta y el texto tan
    // técnico que dejarlo en español es razonable.
    const linkPart = item.reason.includes("link")
      ? `linkeada ↔ source via wikilinks`
      : "";
    const tagsPart =
      item.shared_tags.length > 0
        ? `comparte ${item.shared_tags.length} tag(s): ${item.shared_tags
            .map((t) => "#" + t)
            .join(" ")}`
        : "";
    const parts = [linkPart, tagsPart].filter(Boolean);
    return `score=${item.score} · ${parts.join(" · ") || "match débil"}`;
  }

  private showContextMenu(
    ev: MouseEvent,
    item: RelatedItem,
    ctx: PanelContext,
  ): void {
    const menu = new ObsidianMenu();
    this.buildContextMenu(menu, item, ctx);
    menu.showAtMouseEvent(ev);
  }

  private buildContextMenu(
    menu: Menu,
    item: RelatedItem,
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
          // Wikilink usa el note (basename del .md, sin extensión). Si la
          // nota no tiene `note` populated, usamos el path completo como
          // fallback — el user puede rehacer manualmente.
          const link = `[[${item.note || item.path}]]`;
          void navigator.clipboard.writeText(link);
        }),
    );
  }
}
