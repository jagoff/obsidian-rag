/**
 * Promise wrapper con deadline duro. Heredado del v0.1.0 (vivía en
 * `main.ts`). Re-exportado para que los tests existentes (mismo path
 * lógico, distinto módulo) sigan funcionando.
 *
 * Garantía: la promise resuelta con el valor de `p` si `p` resuelve antes
 * de `ms`, rejected con `Error(label)` si pasa el deadline. NO cancela
 * `p` (no se puede en JS sin AbortController) — solo deja de esperar.
 *
 * Uso típico:
 *   const result = await withTimeout(
 *     mcp.callTool({ name: "rag_query", arguments: ... }),
 *     30_000,
 *     "MCP rag_query >30000ms",
 *   );
 */
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(label)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
