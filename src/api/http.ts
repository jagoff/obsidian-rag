/**
 * HttpBackend — habla con el web server local de obsidian-rag.
 *
 * Usa `requestUrl` de Obsidian (no fetch directo). Razones:
 *   - Bypassea CORS automáticamente (Obsidian es Electron, requestUrl
 *     hace el call desde el main process, no del renderer).
 *   - Funciona en mobile sin polyfills (cuando alguna vez sacamos
 *     isDesktopOnly:true del manifest).
 *   - Maneja timeouts de forma uniforme.
 *
 * Endpoint usado:
 *   GET /api/notes/related?path=<vault-rel>&limit=<int>
 *     → { items: RelatedItem[], source_path: string, reason?: ... }
 *
 * El semanticSearch NO existe como endpoint HTTP todavía (vive en
 * /api/chat con streaming SSE, complejo). Por ahora HttpBackend tira
 * NotSupportedError y AutoBackend lo redirige a McpBackend para esa op.
 */
import { requestUrl, type RequestUrlResponse } from "obsidian";
import {
  type BackendHealth,
  type ContradictionsResponse,
  type LoopsResponse,
  NotSupportedError,
  type RagBackend,
  type RelatedResponse,
  type SemanticHit,
} from "./types";

export class HttpBackend implements RagBackend {
  readonly name = "http";

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number = 5_000,
  ) {}

  async healthCheck(): Promise<BackendHealth> {
    const t0 = Date.now();
    try {
      // /api/model es un endpoint barato (devuelve el modelo de chat
      // configurado, sin tocar el corpus). Si responde 200 → web vivo.
      // Si responde 404 → algo raro pero al menos hay HTTP server.
      // Si tira → conexión rechazada / timeout / DNS, marcar down.
      const resp = await this.request("/api/model", "GET", undefined, 2_000);
      if (resp.status >= 200 && resp.status < 500) {
        return { available: true, latencyMs: Date.now() - t0 };
      }
      return {
        available: false,
        latencyMs: Date.now() - t0,
        error: `HTTP ${resp.status}`,
      };
    } catch (err) {
      return {
        available: false,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getRelated(path: string, limit: number): Promise<RelatedResponse> {
    const params = new URLSearchParams({
      path,
      limit: String(limit),
    });
    const resp = await this.request(
      `/api/notes/related?${params.toString()}`,
      "GET",
    );
    if (resp.status !== 200) {
      throw new Error(
        `getRelated: HTTP ${resp.status} ${this.detail(resp)}`.trim(),
      );
    }
    const body = resp.json as RelatedResponse;
    // Defensa contra response shapes inesperados — si el backend cambió
    // y omite `items`, no rompemos al iterar después.
    return {
      items: Array.isArray(body?.items) ? body.items : [],
      source_path: body?.source_path ?? path,
      reason: body?.reason,
    };
  }

  async getContradictions(
    path: string,
    limit: number,
  ): Promise<ContradictionsResponse> {
    // El endpoint es LLM-bound (5-10s típico). Subimos el timeout por
    // encima del default del backend para cubrir cold-loads del modelo.
    const params = new URLSearchParams({ path, limit: String(limit) });
    const resp = await this.request(
      `/api/notes/contradictions?${params.toString()}`,
      "GET",
      undefined,
      // 45s: cubre hasta el P99 medido del chat call (5-10s cold +
      // margen por si el modelo tiene que evictar otro de MPS).
      45_000,
    );
    if (resp.status !== 200) {
      throw new Error(
        `getContradictions: HTTP ${resp.status} ${this.detail(resp)}`.trim(),
      );
    }
    const body = resp.json as ContradictionsResponse;
    return {
      items: Array.isArray(body?.items) ? body.items : [],
      source_path: body?.source_path ?? path,
      reason: body?.reason,
    };
  }

  async getLoops(path: string, limit: number): Promise<LoopsResponse> {
    // Cheap endpoint (<5ms server-side), no LLM. Usamos el timeout
    // default del backend (5s) — sobra de lejos.
    const params = new URLSearchParams({ path, limit: String(limit) });
    const resp = await this.request(
      `/api/notes/loops?${params.toString()}`,
      "GET",
    );
    if (resp.status !== 200) {
      throw new Error(
        `getLoops: HTTP ${resp.status} ${this.detail(resp)}`.trim(),
      );
    }
    const body = resp.json as LoopsResponse;
    return {
      items: Array.isArray(body?.items) ? body.items : [],
      source_path: body?.source_path ?? path,
      reason: body?.reason,
    };
  }

  async semanticSearch(_question: string, _k: number): Promise<SemanticHit[]> {
    // El endpoint HTTP equivalente sería /api/chat pero éste devuelve un
    // stream SSE con la respuesta del LLM, no chunks crudos. Para reusar
    // el mismo shape que la herramienta MCP `rag_query`, harían falta:
    //   - Endpoint nuevo /api/retrieve (sin LLM, devuelve chunks).
    //   - O parsear el SSE chunk-by-chunk acá.
    // Hoy delegamos a McpBackend vía AutoBackend.
    throw new NotSupportedError(this.name, "semanticSearch");
  }

  async close(): Promise<void> {
    // requestUrl no mantiene conexiones persistentes — no hay nada que cerrar.
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Wrapper de requestUrl con:
   *   - URL absoluta (concat con baseUrl).
   *   - Timeout configurable via Promise.race (requestUrl no soporta
   *     timeout nativo en algunas versiones de Obsidian — defensivo).
   *   - throw=false para que status 4xx no rompa (los manejamos arriba).
   */
  private async request(
    pathAndQuery: string,
    method: "GET" | "POST",
    body?: string,
    overrideTimeoutMs?: number,
  ): Promise<RequestUrlResponse> {
    const url = `${this.baseUrl.replace(/\/$/, "")}${pathAndQuery}`;
    const timeoutMs = overrideTimeoutMs ?? this.timeoutMs;
    const requestPromise = requestUrl({
      url,
      method,
      body,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      throw: false,
    });
    const timeoutPromise = new Promise<RequestUrlResponse>((_, reject) => {
      setTimeout(() => reject(new Error(`HTTP timeout >${timeoutMs}ms`)), timeoutMs);
    });
    return await Promise.race([requestPromise, timeoutPromise]);
  }

  /** Extrae `detail` del body si el server devuelve FastAPI-style errors. */
  private detail(resp: RequestUrlResponse): string {
    try {
      const body = resp.json as { detail?: string };
      return body?.detail ? `(${body.detail})` : "";
    } catch {
      return "";
    }
  }
}
