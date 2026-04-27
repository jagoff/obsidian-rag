/**
 * Helpers de filtrado por excluded folders, espejo de los del backend
 * (web/server.py: `_parse_exclude_folders` + `_is_in_excluded_folder`).
 *
 * Por qué duplicarlos en el plugin:
 *   - HttpBackend pasa el query param y el server filtra → NO se usa este
 *     helper (sería overhead redundante).
 *   - CliBackend invoca `rag related/contradictions/wikilinks suggest`
 *     que NO aceptan flags de exclude_folders todavía. Filtramos
 *     client-side con este helper para que la setting funcione igual
 *     cuando el HTTP server está caído y caemos a CLI.
 *   - McpBackend hoy solo soporta `semanticSearch` (NotSupportedError
 *     en el resto), pero a futuro si se agrega rag_related vía MCP, este
 *     helper sirve para filtrar lo que devuelva.
 *
 * Mantiene las mismas reglas que el backend:
 *   - Trim + rstrip "/" → normalizamos folders a "01-Projects" (no
 *     "01-Projects/" ni " 01-Projects ").
 *   - Match es prefix con trailing "/" para evitar que "04-Archive" matche
 *     "04-Archive-old/foo.md". Excepción: si el path completo == folder,
 *     también excluye (caso degenerado pero defensivo).
 *   - Empty list → no filter (devuelve los items tal cual).
 */
export function parseExcludeFolders(input: string[] | undefined): string[] {
  if (!input || input.length === 0) return [];
  return input
    .map((f) => f.trim().replace(/\/$/, ""))
    .filter((f) => f.length > 0);
}

/**
 * True si `path` cae dentro de cualquiera de los `excludeFolders`.
 * `excludeFolders` debe venir ya pasado por `parseExcludeFolders`.
 */
export function isInExcludedFolder(
  path: string,
  excludeFolders: string[],
): boolean {
  if (excludeFolders.length === 0) return false;
  for (const folder of excludeFolders) {
    if (path === folder) return true;
    if (path.startsWith(folder + "/")) return true;
  }
  return false;
}

/**
 * Filtra una lista de items que tengan un campo string `path` (RelatedItem,
 * ContradictionItem) o `target` (WikilinkSuggestion). El campo se elige
 * con el accessor `getPath`.
 *
 * Si `excludeFolders` está vacío, devuelve la lista original (no copy).
 */
export function filterByExcludedFolders<T>(
  items: T[],
  excludeFolders: string[],
  getPath: (item: T) => string,
): T[] {
  const parsed = parseExcludeFolders(excludeFolders);
  if (parsed.length === 0) return items;
  return items.filter((item) => !isInExcludedFolder(getPath(item), parsed));
}
