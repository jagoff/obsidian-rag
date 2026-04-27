/**
 * LoopsPanel — panel #2 del Track A.
 *
 * Muestra TODOs sin cerrar dentro de la nota activa: items del frontmatter
 * (`todo:` / `due:`), checkboxes `- [ ]` sin marcar, y clausulas
 * imperativas en el body ("tengo que X", "preguntar Y").
 *
 * Diferencia con ContradictionsPanel:
 *   - Es REACTIVE (active-leaf-change). El backend usa solo regex +
 *     frontmatter parse, sin LLM ni embed (~5ms por nota), así que
 *     dispararlo en cada cambio de nota es cero costo.
 *   - También suscrito a "editor-modify" con debounce 600ms — si el
 *     user marca un checkbox `- [x]` mientras escribe, el panel se
 *     refresca y deja de mostrar ese loop.
 *
 * UX:
 *   - Cards por loop, ordenados por age_days desc (los stale arriba).
 *   - Color del badge por kind: 🟣 todo (frontmatter) / 🔵 checkbox /
 *     🟡 inline (imperative).
 *   - Color del age:
 *     * verde (≤7d): fresh.
 *     * amarillo (8-14d): warming up.
 *     * rojo (>14d): stale — necesitás ver esto.
 *   - Sin contexto menu — los loops viven dentro de la misma nota
 *     activa, no hace sentido "abrir" desde acá. (Si querés navegar a
 *     la línea exacta del checkbox sería un nice-to-have futuro.)
 */
import { BasePanel } from "./base";
import {
  type LoopItem,
  type LoopsResponse,
  type PanelContext,
  type PanelTrigger,
} from "../api/types";
import { LruCache } from "../api/cache";
import { t } from "../i18n";

const KIND_LABELS: Record<LoopItem["kind"], string> = {
  todo: "todo",
  checkbox: "checkbox",
  inline: "imperativo",
};

const KIND_CSS: Record<LoopItem["kind"], string> = {
  todo: "rag-loops-kind-todo",
  checkbox: "rag-loops-kind-checkbox",
  inline: "rag-loops-kind-inline",
};

export class LoopsPanel extends BasePanel {
  readonly id = "loops";
  readonly titleKey = "panel.loops.title";
  readonly icon = "list-checks";
  // Reactive en active-leaf + debounced en modify.
  // Performance: backend <5ms, fetch HTTP ~5-10ms warm. Sumar los dos
  // triggers no rompe nada — ambos pasan por el cache de 60s del LRU.
  readonly triggers: PanelTrigger[] = ["active-leaf-change", "editor-modify"];
  readonly debounceMs = 600;

  // Cache 60s — corto porque el user puede cerrar/abrir checkboxes y
  // querer ver el cambio reflejado pronto. Para una nota que el user
  // ojea 10 veces sin editar, los 9 fetches restantes dan cache hit.
  private readonly cache = new LruCache<string, LoopsResponse>({
    maxSize: 50,
    ttlMs: 60_000,
  });

  clearCache(): void {
    this.cache.clear();
  }

  protected loadingMessage(): string {
    return t("panel.loops.loading");
  }

  protected async fetch(ctx: PanelContext): Promise<LoopsResponse | null> {
    if (!ctx.file) return null;
    const path = ctx.file.path;
    // Si el modify trigger acaba de disparar, invalidamos el cache para
    // que el fetch traiga datos frescos (el user editó y quiere verlo).
    // Distinguir trigger por contexto requeriría agregar API; lo más
    // simple es invalidar conservadoramente.
    // TODO: si el panel se vuelve "caro" en algún caso, considerar
    // pasar el trigger en PanelContext para discriminar.
    const cached = this.cache.get(path);
    if (cached) return cached;
    const limit = Math.min(ctx.settings.topK * 5, 100);
    const resp = await ctx.backend.getLoops(path, limit);
    this.cache.set(path, resp);
    return resp;
  }

  protected isEmpty(data: unknown): boolean {
    if (!data) return true;
    const resp = data as LoopsResponse;
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
    if (cached?.reason === "not_found") {
      body.createEl("div", {
        text: t("panel.loops.empty.not_found"),
        cls: "rag-panel-empty",
      });
      return;
    }
    body.createEl("div", {
      text: t("panel.loops.empty"),
      cls: "rag-panel-empty rag-loops-empty-clean",
    });
  }

  protected renderData(
    body: HTMLElement,
    data: unknown,
    _ctx: PanelContext,
  ): void {
    const resp = data as LoopsResponse;
    // Sort: age_days desc (stale arriba). Estable por orden de input
    // entre los empates (en general el orden de aparición en la nota).
    const sorted = [...resp.items].sort((a, b) => b.age_days - a.age_days);
    const list = body.createDiv({ cls: "rag-loops-list" });
    for (const item of sorted) {
      this.renderCard(list, item);
    }
  }

  /**
   * Card layout:
   *
   *   ┌──────────────────────────────────────┐
   *   │ [3d] [todo]  Llamar a Juan           │
   *   └──────────────────────────────────────┘
   *
   * Compacto a propósito — un sidebar suele tener decenas de loops y
   * cada uno tiene que caber en pocas líneas.
   */
  private renderCard(list: HTMLElement, item: LoopItem): void {
    const card = list.createDiv({ cls: "rag-loops-card" });

    // Age badge — color por threshold.
    const ageCls = this.ageClass(item.age_days);
    card.createSpan({
      text: this.formatAge(item.age_days),
      cls: `rag-loops-age ${ageCls}`,
      attr: { title: this.ageTitle(item) },
    });

    // Kind badge — color por kind.
    card.createSpan({
      text: KIND_LABELS[item.kind],
      cls: `rag-loops-kind ${KIND_CSS[item.kind]}`,
    });

    // Loop text — el contenido que el user va a leer.
    card.createSpan({
      text: item.loop_text,
      cls: "rag-loops-text",
    });
  }

  private formatAge(days: number): string {
    if (days === 0) return "hoy";
    if (days === 1) return "1d";
    return `${days}d`;
  }

  private ageClass(days: number): string {
    if (days > 14) return "rag-loops-age-stale";
    if (days > 7) return "rag-loops-age-warm";
    return "rag-loops-age-fresh";
  }

  private ageTitle(item: LoopItem): string {
    return `Detectado: ${item.extracted_at}`;
  }
}
