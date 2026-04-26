/**
 * Type contracts compartidos por todos los backends y panels.
 *
 * El sidebar habla con UN `RagBackend` abstracto. Las 3 implementaciones
 * (HTTP / CLI / MCP) viven en `src/api/{http,cli,mcp}.ts` y siguen este
 * contrato. `AutoBackend` (`src/api/auto.ts`) las componene en cascade
 * con health-check antes de cada call.
 *
 * Todas las shapes (RelatedItem, SemanticHit, etc.) reflejan el JSON que
 * devuelve el web server (`/api/notes/related`, `/api/chat`, etc.) o el
 * CLI (`rag related --json`). Si cambia el shape backend ↔ frontend, se
 * actualiza acá UNA vez y todos los panels que consumen ese shape ven el
 * fix automático.
 */
import type { App } from "obsidian";

// ── Settings ──────────────────────────────────────────────────────────────

/** Cómo elegimos qué backend usar. */
export type BackendMode =
  | "auto"     // Probar HTTP → CLI → MCP en cascada (default + recomendado).
  | "http"    // Forzar HTTP. Fallar si el web server no responde.
  | "cli"     // Forzar spawn del CLI `rag related`. Más lento pero standalone.
  | "mcp";    // Forzar MCP stdio (legacy del v0.1.0). Útil si el web no está.

export interface RagSettings {
  // Transport
  backendMode: BackendMode;
  httpUrl: string;             // Default: "http://127.0.0.1:8765"
  ragBinaryPath: string;       // Default: "/Users/<user>/.local/bin/rag"
  mcpBinaryPath: string;       // Default: "/Users/<user>/.local/bin/obsidian-rag-mcp"
  queryTimeoutMs: number;

  // Panels
  topK: number;                // Cuántos items pide cada panel por default.
  panelOrder: string[];        // IDs de panels en orden visual.
  panelCollapsed: Record<string, boolean>; // Estado colapsado por panel id.
  panelEnabled: Record<string, boolean>;   // Toggle on/off por panel id.

  // i18n
  language: "es" | "en";
}

export const DEFAULT_SETTINGS: RagSettings = {
  backendMode: "auto",
  httpUrl: "http://127.0.0.1:8765",
  // Estos defaults son razonables para `uv tool install --editable` en macOS.
  // El SettingTab los muestra para que el user los corrija si su install vive
  // en otro lado (p. ej. Linux con `~/.local/bin/`, o un Homebrew prefix).
  ragBinaryPath: "/Users/fer/.local/bin/rag",
  mcpBinaryPath: "/Users/fer/.local/bin/obsidian-rag-mcp",
  queryTimeoutMs: 30_000,

  topK: 10,
  // Los panels conocidos. El ID del panel = key acá. Los panels que se
  // registran después de la primera carga heredan defaultCollapsed=false
  // y default order al final del stack.
  panelOrder: ["related-notes", "semantic-search"],
  panelCollapsed: {
    "related-notes": false,
    "semantic-search": true,
  },
  panelEnabled: {
    "related-notes": true,
    "semantic-search": true,
  },

  language: "es",
};

// ── Domain shapes ────────────────────────────────────────────────────────

/**
 * Item devuelto por `find_related` (panel "Notas relacionadas").
 *
 * `reason` indica por qué el item es relevante para el UI:
 *   - "tags"      → comparten ≥2 tags pero no hay link.
 *   - "link"      → hay outlink/backlink pero <2 tags compartidos.
 *   - "tags+link" → ambos: tags + edges del grafo (lo más fuerte).
 *
 * `score` es int (no float) — tags counted + 2× link edges. No es 0..1.
 */
export interface RelatedItem {
  path: string;
  note: string;
  folder: string;
  tags: string[];
  shared_tags: string[];
  score: number;
  reason: "tags" | "link" | "tags+link";
}

export interface RelatedResponse {
  items: RelatedItem[];
  source_path: string;
  reason?: "empty_index" | "not_indexed";
}

/**
 * Hit de `rag_query` (panel "Búsqueda semántica" — herencia del v0.1.0).
 *
 * Distinto de RelatedItem: éste viene del retrieve+rerank con cross-encoder,
 * tiene un `content` chunk de markdown, y `score` es float (rerank score).
 */
export interface SemanticHit {
  path: string;
  note: string;
  score: number;
  content: string;
  folder?: string;
  tags?: string[];
}

// ── Backend contract ─────────────────────────────────────────────────────

/**
 * Resultado de health-check. Los AutoBackend la consulta antes de elegir.
 *
 * `available` false con `error` no-null = backend down (ej. web server
 * caído, binario no existe). `available` true con `latencyMs` permite
 * priorizar HTTP cuando todos están vivos.
 */
export interface BackendHealth {
  available: boolean;
  latencyMs?: number;
  error?: string;
}

/**
 * Contrato común para los 3 backends. Cada método mapea 1:1 a un panel
 * que necesita esa data. Cuando agregamos un panel nuevo (ej. loops,
 * contradicciones), agregamos un método acá + las 3 implementaciones.
 */
export interface RagBackend {
  /** Nombre legible para logs ("http", "cli", "mcp"). */
  readonly name: string;

  /**
   * Quick health check (debe completar en <2s). Llamado por AutoBackend
   * antes de elegir, y por la settings tab para mostrar status.
   */
  healthCheck(): Promise<BackendHealth>;

  /** Notas relacionadas a `path` por shared_tags + graph hops. */
  getRelated(path: string, limit: number): Promise<RelatedResponse>;

  /**
   * Semantic search del legacy v0.1.0. Reusa `rag_query` MCP tool. Solo
   * MCP backend lo implementa nativamente; HTTP/CLI necesitarían un
   * endpoint nuevo. Los backends que no lo soportan tiran NotSupportedError.
   */
  semanticSearch(question: string, k: number): Promise<SemanticHit[]>;

  /** Cleanup de recursos (cerrar stdio, abortar in-flight, etc.). */
  close(): Promise<void>;
}

export class NotSupportedError extends Error {
  constructor(backend: string, op: string) {
    super(`Backend "${backend}" no soporta operación "${op}"`);
    this.name = "NotSupportedError";
  }
}

// ── Panel context ────────────────────────────────────────────────────────

/**
 * Lo que cada panel recibe al re-render. La view mantiene el estado del
 * file activo + cursor + selection y se lo pasa a los panels que estén
 * suscritos al trigger correspondiente.
 */
export interface PanelContext {
  app: App;
  file: { path: string; basename: string; folder: string } | null;
  selection: string | null;
  // Hook al backend activo. Los panels NO instancian backends — la view se
  // encarga (vía settings) y se los pasa por context.
  backend: RagBackend;
  settings: RagSettings;
  // Para que el panel pida re-render parcial sin recargar todo el stack.
  requestRerender: () => void;
  // Para abrir notas desde clicks dentro del panel. Centralizado acá para
  // que el panel no dependa de App directo (testeable más fácil).
  openNote: (path: string, options?: { newPane?: boolean }) => Promise<void>;
}

/**
 * Triggers a los que un panel puede suscribirse. La view orquesta el
 * fetch+render cuando uno de estos eventos se dispara.
 */
export type PanelTrigger =
  | "active-leaf-change"  // Cambió la nota activa.
  | "editor-modify"        // El usuario está tipeando (debounced).
  | "manual";              // El user dispara con un botón / hotkey.
