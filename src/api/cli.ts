/**
 * CliBackend — spawnea `rag related <path> --json` y parsea stdout.
 *
 * Usado solo cuando HTTP falla y MCP no está disponible (o el user lo
 * fuerza desde settings). Es ~20-50× más lento que HTTP en cold start
 * porque cada call paga el bootstrap de Click + Python imports
 * (~300-1000ms vs ~5-30ms HTTP warm). Pero es el último recurso —
 * funciona aunque no haya web server corriendo, mientras el binario
 * exista.
 *
 * Comando consumido:
 *   rag related <path> --json [--limit N]
 *     → stdout: {"items": [...], "source_path": ..., "reason": ...?}
 *     → exit 0 happy / exit 2 invalid path
 *
 * Cargamos `child_process` lazy + via require para evitar que esbuild
 * lo bundlee — está marcado como `external` en esbuild.config.mjs y vive
 * en el Node.js de Electron en runtime. Si el plugin algún día corre en
 * mobile, este backend simplemente no estará disponible (manifest tiene
 * isDesktopOnly:true, así que no es un problema hoy).
 */
import {
  type BackendHealth,
  type ContradictionsResponse,
  NotSupportedError,
  type RagBackend,
  type RelatedResponse,
  type SemanticHit,
} from "./types";

// Lazy require para que esbuild no se queje y para que el binding se
// evalúe en runtime (donde sí existe `child_process`).
type ExecFile = (
  file: string,
  args: string[],
  options: { timeout?: number; maxBuffer?: number },
  cb: (err: Error | null, stdout: string, stderr: string) => void,
) => void;

let _execFileCache: ExecFile | null = null;
function getExecFile(): ExecFile {
  if (_execFileCache) return _execFileCache;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require("child_process") as { execFile: ExecFile };
  _execFileCache = cp.execFile;
  return _execFileCache;
}

export class CliBackend implements RagBackend {
  readonly name = "cli";

  constructor(
    private readonly binaryPath: string,
    private readonly timeoutMs: number = 30_000,
  ) {}

  async healthCheck(): Promise<BackendHealth> {
    const t0 = Date.now();
    try {
      // `rag --version` tiene que existir y completarse rápido. Si el
      // binario no existe → ENOENT → marcamos down. Si existe pero `rag`
      // tiene otro error (depender broken, etc.), también lo capturamos.
      await this.execJson(["--version"], 5_000);
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
    const args = ["related", path, "--json", "--limit", String(limit)];
    const stdout = await this.execJson(args);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new Error(
        `CLI no devolvió JSON válido: ${err instanceof Error ? err.message : err}`,
      );
    }
    const body = parsed as RelatedResponse;
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
    // Override del timeout default para acomodar cold-load del chat LLM
    // (5-10s típico + margen). El CLI además paga el bootstrap de Click
    // + imports de torch (~300-500ms más).
    const args = ["contradictions", path, "--json", "--limit", String(limit)];
    const stdout = await this.execJson(args, 60_000);
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch (err) {
      throw new Error(
        `CLI no devolvió JSON válido: ${err instanceof Error ? err.message : err}`,
      );
    }
    const body = parsed as ContradictionsResponse;
    return {
      items: Array.isArray(body?.items) ? body.items : [],
      source_path: body?.source_path ?? path,
      reason: body?.reason,
    };
  }

  async semanticSearch(_question: string, _k: number): Promise<SemanticHit[]> {
    // Hoy `rag query` existe pero su output no devuelve los chunks crudos
    // en JSON (printea con rich + sources). Habría que agregar
    // `rag query <q> --json --no-llm` para skippear el LLM y devolver el
    // retrieve+rerank shape. Mientras tanto, delegamos a McpBackend.
    throw new NotSupportedError(this.name, "semanticSearch");
  }

  async close(): Promise<void> {
    // execFile spawn-and-forget — cada call termina por sí solo. No hay
    // estado persistente que cerrar.
  }

  // ── Internals ─────────────────────────────────────────────────────────

  /**
   * Wrapper de `child_process.execFile` con Promise + timeout configurable.
   * Devuelve stdout completo (no streaming). Si el comando exit !== 0,
   * incluye stderr en el error message.
   */
  private execJson(args: string[], overrideTimeoutMs?: number): Promise<string> {
    const timeout = overrideTimeoutMs ?? this.timeoutMs;
    return new Promise((resolve, reject) => {
      const execFile = getExecFile();
      execFile(
        this.binaryPath,
        args,
        {
          timeout,
          // 4 MB max buffer — excede largamente lo que `rag related --json`
          // genera (típicamente <10KB), pero damos margen para queries
          // futuras con --limit alto + 50 items.
          maxBuffer: 4 * 1024 * 1024,
        },
        (err, stdout, stderr) => {
          if (err) {
            const stderrSnip = stderr ? `\n${stderr.slice(0, 500)}` : "";
            reject(new Error(`CLI exit error: ${err.message}${stderrSnip}`));
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}
