/**
 * McpBackend — habla con `obsidian-rag-mcp` via stdio (MCP protocol).
 *
 * Refactor del code original del plugin v0.1.0. Reusa exactamente los
 * helpers que vivían en el `main.ts` legacy (`parseHits`, `withTimeout`)
 * — los movimos a `src/utils/` para que la suite de tests existente los
 * encuentre sin re-escribir.
 *
 * Capabilities cubiertas:
 *   - `getRelated` vía la herramienta MCP `rag_query` con la nota source
 *     como contexto. NOTA: el ranking acá es semantic-search, NO la
 *     misma señal que `find_related` (tags + grafo). Por eso este
 *     backend marca todos los items como reason="tags" — es la mejor
 *     aproximación. Los users que quieran el shape correcto deben
 *     dejar el AutoBackend en HTTP/CLI.
 *   - `semanticSearch` nativo — la herramienta MCP `rag_query` calza
 *     1:1 con esta op.
 *
 * Lifecycle:
 *   - Cliente lazy: el primer call construye `StdioClientTransport` +
 *     `Client` y los reusa hasta `close()`. Reduce el cost del bootstrap
 *     del binary a 1 vez por sesión Obsidian (~1-2s) en lugar de cada call.
 *   - `close()` cierra ambos. La view lo llama en `onunload` para no
 *     dejar zombies — vimos en debugging que el binary mantiene torch +
 *     sentence-transformers cargados (~1-4 GB RSS) hasta que muere.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { withTimeout } from "../utils/timeout";
import { parseHits } from "../utils/parse-hits";
import {
  type BackendHealth,
  type ContradictionsResponse,
  type LoopsResponse,
  NotSupportedError,
  type RagBackend,
  type RelatedItem,
  type RelatedResponse,
  type SemanticHit,
  type WikilinkSuggestionsResponse,
} from "./types";

export class McpBackend implements RagBackend {
  readonly name = "mcp";

  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;

  constructor(
    private readonly binaryPath: string,
    private readonly timeoutMs: number = 30_000,
  ) {}

  async healthCheck(): Promise<BackendHealth> {
    const t0 = Date.now();
    try {
      // Tocar `rag_stats` — barata (no toca el corpus, solo lee el
      // collection name + count). Si el binary no existe, falla en el
      // connect con ENOENT.
      const client = await this.ensureClient();
      await withTimeout(
        client.callTool({ name: "rag_stats", arguments: {} }),
        5_000,
        "MCP healthCheck rag_stats >5000ms",
      );
      return { available: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return {
        available: false,
        latencyMs: Date.now() - t0,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async getRelated(path: string, limit: number): Promise<RelatedResponse> {
    // Estrategia: usar rag_query con el path como query. NO es lo mismo
    // que find_related (que usa tags + grafo) — éste hace retrieve
    // semántico con la nota como query. Mejor que nada cuando HTTP/CLI
    // no responden, pero documentado: los items vienen sin reason real.
    const hits = await this.semanticSearch(path, limit);
    const items: RelatedItem[] = hits
      .filter((h) => h.path && h.path !== path) // Excluir la propia source.
      .slice(0, limit)
      .map((h) => ({
        path: h.path,
        note: h.note || h.path,
        folder: h.folder ?? "",
        tags: h.tags ?? [],
        // McpBackend no tiene la noción de "tags compartidos" — el rerank
        // score es la única señal. Devolvemos array vacío para que el UI
        // simplemente no muestre el chip de "shared tags".
        shared_tags: [],
        // Score MCP es float 0..1 (rerank cross-encoder). Lo escalamos
        // ×100 + truncamos a int para que el UI lo trate uniforme con
        // los scores de find_related (también int).
        score: Math.round(h.score * 100),
        // Estamos mintiendo un poco — no tenemos cómo distinguir
        // tags vs link sin tocar el grafo. "tags" es el menos
        // engañoso para el UI por defecto.
        reason: "tags",
      }));
    return { items, source_path: path };
  }

  async getContradictions(
    _path: string,
    _limit: number,
  ): Promise<ContradictionsResponse> {
    // El MCP server expone `rag_query`, `rag_read_note`, `rag_list_notes`,
    // `rag_links`, `rag_stats`, `rag_followup` + write tools, pero NO
    // una herramienta para contradicciones. Podríamos fakearlo embedding
    // el body + pulling chunks + reranking localmente, pero el paso
    // final (clasificación "contradice vs complementa") necesita el
    // chat LLM — que es lo mismo que el HTTP endpoint hace. No agrega
    // valor y corre el riesgo de divergir del shape canónico.
    //
    // Si el user forzó backend=mcp en settings, AutoBackend no lo
    // alcanza y este throw se propaga al panel → renderea "backend no
    // soporta contradicciones" con link a settings para cambiar a auto.
    throw new NotSupportedError(this.name, "getContradictions");
  }

  async getLoops(_path: string, _limit: number): Promise<LoopsResponse> {
    // El MCP server tiene `rag_followup` (similar pero scope=vault, no
    // por nota). Mappear MCP → "loops por nota" requeriría parsear todo
    // el corpus client-side. AutoBackend salta a HTTP/CLI primero, este
    // throw solo se alcanza si el user forzó backend=mcp en settings.
    throw new NotSupportedError(this.name, "getLoops");
  }

  async getWikilinkSuggestions(
    _path: string,
    _limit: number,
  ): Promise<WikilinkSuggestionsResponse> {
    // El MCP server no expone una tool de "wikilink suggestions".
    // Implementarla via rag_query + parse del corpus client-side
    // sería complejo y duplicaría lógica del backend. AutoBackend
    // salta a HTTP/CLI primero — este throw solo se alcanza si el
    // user forzó backend=mcp en settings.
    throw new NotSupportedError(this.name, "getWikilinkSuggestions");
  }

  async semanticSearch(question: string, k: number): Promise<SemanticHit[]> {
    const client = await this.ensureClient();
    const resp = await withTimeout(
      client.callTool({
        name: "rag_query",
        arguments: { question, k },
      }),
      this.timeoutMs,
      `MCP rag_query >${this.timeoutMs}ms`,
    );
    return parseHits(resp);
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      // Best-effort cleanup — ya estamos shutting down.
    }
    try {
      await this.transport?.close();
    } catch {
      // Idem.
    }
    this.client = null;
    this.transport = null;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Lazy single-shot init del cliente MCP. Reusa el mismo transport para
   * todos los calls hasta que close() lo limpia. Concurrent callers ven
   * la misma promise (el await del check + new + connect garantiza que
   * el segundo entrante vea el client ya seteado).
   */
  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    const transport = new StdioClientTransport({
      command: this.binaryPath,
      args: [],
    });
    const client = new Client(
      { name: "obsidian-rag-plugin", version: "0.2.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    this.transport = transport;
    this.client = client;
    return client;
  }
}
