/**
 * Parser para la response del MCP tool `rag_query`. Heredado del v0.1.0
 * (vivía en `main.ts`). Re-exportado tal cual para que la suite `bun
 * test` siga importándolo desde acá sin re-escribir.
 *
 * Formato esperado del MCP:
 *   { content: [{ type: "text", text: '<JSON array de hits>' }, ...] }
 *
 * Tolerante a:
 *   - response sin `content` o con `content` no array → []
 *   - texto que no sea JSON parseable → []
 *   - campos alternativos: `path|file`, `score|rerank_score`, `content|text`
 *     (refleja drift histórico del MCP server).
 *
 * Si parseHits devuelve [], el caller debería interpretarlo como
 * "no results / shape inesperado", no como error fatal.
 */
import type { SemanticHit } from "../api/types";

export function parseHits(resp: unknown): SemanticHit[] {
  const content = (resp as { content?: Array<{ type: string; text?: string }> })
    ?.content;
  if (!Array.isArray(content)) return [];
  const textBlock = content.find((c) => c.type === "text" && c.text);
  if (!textBlock?.text) return [];
  try {
    const parsed = JSON.parse(textBlock.text);
    if (!Array.isArray(parsed)) return [];
    return parsed.map((h: Record<string, unknown>) => ({
      path: String(h.path ?? h.file ?? ""),
      note: String(h.note ?? h.path ?? ""),
      score: Number(h.score ?? h.rerank_score ?? 0),
      content: String(h.content ?? h.text ?? ""),
      folder: typeof h.folder === "string" ? h.folder : undefined,
      tags: Array.isArray(h.tags) ? (h.tags as string[]) : undefined,
    }));
  } catch {
    return [];
  }
}
