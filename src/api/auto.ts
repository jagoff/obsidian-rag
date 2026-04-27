/**
 * AutoBackend — compone HttpBackend + CliBackend + McpBackend con
 * health-check cacheado y fallback automático.
 *
 * Estrategia:
 *   1. Health check inicial a los 3 (en paralelo). Cacheamos el
 *      resultado por `healthCacheTtlMs` (default 30s).
 *   2. Para cada call (`getRelated` / `semanticSearch`):
 *      a. Filtrar a los backends que reportaron available=true Y
 *         soportan la operación (HTTP/CLI no implementan
 *         semanticSearch — saltamos a MCP directo).
 *      b. Probar en orden: HTTP → CLI → MCP.
 *      c. Si el primero falla con un error transitorio (timeout, ECONN),
 *         marcar su health como down + intentar el siguiente.
 *      d. Si todos fallan, propagar el último error.
 *
 * Por qué health-check cacheado: si re-chequeáramos en cada call
 * agregaríamos latencia significativa al panel reactive. 30s cubre el
 * caso común "el web server está vivo todo el tiempo de la sesión", y
 * para detectar caídas en menos invalida explícitamente con
 * `forceRefreshHealth()` cuando un call real falla con un error que
 * sugiere que el backend murió.
 */
import {
  type BackendHealth,
  type ContradictionsResponse,
  type RagBackend,
  type RelatedResponse,
  type SemanticHit,
} from "./types";

interface HealthEntry {
  health: BackendHealth;
  checkedAt: number;
}

export class AutoBackend implements RagBackend {
  readonly name = "auto";

  private readonly health = new Map<string, HealthEntry>();
  private readonly healthCacheTtlMs: number;

  constructor(
    private readonly backends: RagBackend[],
    opts: { healthCacheTtlMs?: number } = {},
  ) {
    this.healthCacheTtlMs = opts.healthCacheTtlMs ?? 30_000;
  }

  async healthCheck(): Promise<BackendHealth> {
    // El health del Auto = OR de los hijos. Si al menos uno está vivo,
    // estamos vivos. Latency = mínima entre los disponibles.
    await this.refreshAllHealth();
    const alive = [...this.health.values()].filter((e) => e.health.available);
    if (!alive.length) {
      const errors = [...this.health.entries()]
        .map(([name, e]) => `${name}: ${e.health.error ?? "unknown"}`)
        .join(", ");
      return { available: false, error: `todos los backends down — ${errors}` };
    }
    const minLatency = Math.min(
      ...alive.map((e) => e.health.latencyMs ?? Number.POSITIVE_INFINITY),
    );
    return {
      available: true,
      latencyMs: Number.isFinite(minLatency) ? minLatency : undefined,
    };
  }

  async getRelated(path: string, limit: number): Promise<RelatedResponse> {
    return this.tryInOrder(
      "getRelated",
      this.backends,
      (b) => b.getRelated(path, limit),
    );
  }

  async getContradictions(
    path: string,
    limit: number,
  ): Promise<ContradictionsResponse> {
    return this.tryInOrder(
      "getContradictions",
      this.backends,
      (b) => b.getContradictions(path, limit),
    );
  }

  async semanticSearch(question: string, k: number): Promise<SemanticHit[]> {
    return this.tryInOrder(
      "semanticSearch",
      this.backends,
      (b) => b.semanticSearch(question, k),
    );
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.backends.map((b) => b.close()));
  }

  /**
   * Forzar invalidación del cache de health del backend `name`. Llamado
   * cuando un call real fallai con un error que sugiere que el backend
   * cayó (timeout, ECONNREFUSED, ENOENT). El siguiente call hace
   * re-check antes de intentarlo de nuevo.
   */
  forceRefreshHealth(name: string): void {
    this.health.delete(name);
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Probar los backends en orden hasta que uno responda. Backends con
   * health.available=false (cacheado) se saltan. NotSupportedError no
   * cuenta como fallo del backend (es una capability limitation, no down).
   */
  private async tryInOrder<T>(
    op: string,
    backends: RagBackend[],
    fn: (b: RagBackend) => Promise<T>,
  ): Promise<T> {
    let lastError: Error | null = null;
    for (const backend of backends) {
      const health = await this.getHealth(backend);
      if (!health.available) {
        // Backend marcado down — saltar sin intentar.
        continue;
      }
      try {
        return await fn(backend);
      } catch (err) {
        // NotSupportedError → este backend simplemente no implementa
        // esta op. Saltar al siguiente sin marcar down.
        if (err instanceof Error && err.name === "NotSupportedError") {
          lastError = err;
          continue;
        }
        // Cualquier otro error → marcar el backend down (por si fue
        // timeout / connection drop / binary murió) e intentar el
        // siguiente. La invalidación dispara re-check en el próximo call.
        this.forceRefreshHealth(backend.name);
        lastError = err instanceof Error ? err : new Error(String(err));
        continue;
      }
    }
    throw lastError ?? new Error(`no hay backend disponible para ${op}`);
  }

  /** Devuelve el health del backend (cacheado o re-checked si expiró). */
  private async getHealth(backend: RagBackend): Promise<BackendHealth> {
    const entry = this.health.get(backend.name);
    if (entry && Date.now() - entry.checkedAt < this.healthCacheTtlMs) {
      return entry.health;
    }
    const health = await backend.healthCheck();
    this.health.set(backend.name, { health, checkedAt: Date.now() });
    return health;
  }

  /** Re-check todos los backends en paralelo. Llamado por `healthCheck()`. */
  private async refreshAllHealth(): Promise<void> {
    await Promise.all(
      this.backends.map(async (b) => {
        const health = await b.healthCheck();
        this.health.set(b.name, { health, checkedAt: Date.now() });
      }),
    );
  }
}
