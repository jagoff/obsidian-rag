/**
 * i18n minimal con dict en memoria. NO levantamos un framework (i18next,
 * fluent, etc.) porque el plugin tiene <100 strings traducibles y se
 * carga adentro de Obsidian — cada KB cuenta para el bundle final.
 *
 * Uso:
 *   import { t } from "./i18n";
 *   t("sidebar.title")  // "Notas relacionadas" o "Related notes"
 *
 * Para agregar idiomas: extender STRINGS con la clave nueva. Si una key
 * falta en un idioma, fallback a inglés (no error).
 *
 * El idioma activo se resuelve via settings.language. Cuando el user lo
 * cambia en settings, llamar `setLanguage(newLang)` y luego forzar el
 * re-render del sidebar (la view lo hace en el handler de settings).
 */

type Lang = "es" | "en";

let _activeLang: Lang = "es";

export function setLanguage(lang: Lang): void {
  _activeLang = lang;
}

export function getLanguage(): Lang {
  return _activeLang;
}

const STRINGS: Record<string, Record<Lang, string>> = {
  // Sidebar shell ─────────────────────────────────────
  "sidebar.view_title": {
    es: "RAG",
    en: "RAG",
  },
  "sidebar.empty": {
    es: "Abrí una nota para ver datos relacionados.",
    en: "Open a note to see related data.",
  },
  "sidebar.refresh": {
    es: "Refrescar",
    en: "Refresh",
  },
  "sidebar.collapse": {
    es: "Colapsar panel",
    en: "Collapse panel",
  },
  "sidebar.expand": {
    es: "Expandir panel",
    en: "Expand panel",
  },

  // Panel: Related Notes ─────────────────────────────
  "panel.related.title": {
    es: "Notas relacionadas",
    en: "Related notes",
  },
  "panel.related.empty": {
    es: "Sin relaciones encontradas. Agregá tags o linkeá esta nota a otras.",
    en: "No relations found. Add tags or link this note to others.",
  },
  "panel.related.empty.not_indexed": {
    es: "Esta nota no está indexada todavía. Corré `rag index` o esperá al watcher.",
    en: "This note isn't indexed yet. Run `rag index` or wait for the watcher.",
  },
  "panel.related.empty.empty_index": {
    es: "El índice está vacío. Corré `rag index` para indexar el vault.",
    en: "Index is empty. Run `rag index` to index your vault.",
  },
  "panel.related.loading": {
    es: "Buscando relacionadas...",
    en: "Finding related notes...",
  },
  "panel.related.reason.tags": {
    es: "tags",
    en: "tags",
  },
  "panel.related.reason.link": {
    es: "link",
    en: "link",
  },
  "panel.related.reason.tags+link": {
    es: "tags + link",
    en: "tags + link",
  },
  "panel.related.menu.open": {
    es: "Abrir nota",
    en: "Open note",
  },
  "panel.related.menu.open_split": {
    es: "Abrir en split",
    en: "Open in split pane",
  },
  "panel.related.menu.copy_link": {
    es: "Copiar wikilink",
    en: "Copy wikilink",
  },

  // Panel: Contradictions ────────────────────────────
  "panel.contradictions.title": {
    es: "Posibles contradicciones",
    en: "Possible contradictions",
  },
  "panel.contradictions.idle": {
    es: "El análisis de contradicciones usa un LLM (~10s por nota). Click para arrancar.",
    en: "Contradiction analysis uses an LLM (~10s per note). Click to start.",
  },
  "panel.contradictions.idle_action": {
    es: "Analizar esta nota",
    en: "Analyze this note",
  },
  "panel.contradictions.loading": {
    es: "Buscando contradicciones con el LLM... (puede tardar ~10s)",
    en: "Looking for contradictions via LLM... (may take ~10s)",
  },
  "panel.contradictions.empty": {
    es: "✓ No se encontraron contradicciones entre esta nota y otras del vault.",
    en: "✓ No contradictions found between this note and others in the vault.",
  },
  "panel.contradictions.empty.too_short": {
    es: "Nota muy corta (<200 chars) para analizar. Escribí más prosa y reintentá.",
    en: "Note too short (<200 chars) to analyze. Add more prose and retry.",
  },
  "panel.contradictions.empty.not_indexed": {
    es: "Esta nota no está indexada. Corré `rag index` o esperá al watcher.",
    en: "This note isn't indexed. Run `rag index` or wait for the watcher.",
  },
  "panel.contradictions.empty.empty_index": {
    es: "El índice está vacío. Corré `rag index` para indexar el vault.",
    en: "Index is empty. Run `rag index` to index your vault.",
  },
  "panel.contradictions.why_prefix": {
    es: "Tensión:",
    en: "Tension:",
  },

  // Panel: Loops ─────────────────────────────────────
  "panel.loops.title": {
    es: "Loops abiertos",
    en: "Open loops",
  },
  "panel.loops.loading": {
    es: "Buscando loops...",
    en: "Looking for loops...",
  },
  "panel.loops.empty": {
    es: "✓ Sin loops abiertos en esta nota.",
    en: "✓ No open loops in this note.",
  },
  "panel.loops.empty.not_found": {
    es: "Esta nota no existe en el vault.",
    en: "This note doesn't exist in the vault.",
  },

  // Panel: Wikilink Suggestions ──────────────────────
  "panel.wikilinks.title": {
    es: "Wikilinks sugeridos",
    en: "Suggested wikilinks",
  },
  "panel.wikilinks.loading": {
    es: "Buscando wikilinks faltantes...",
    en: "Looking for missing wikilinks...",
  },
  "panel.wikilinks.empty": {
    es: "✓ Sin wikilinks faltantes — todas las menciones ya están linkeadas.",
    en: "✓ No missing wikilinks — all mentions are linked.",
  },
  "panel.wikilinks.empty.empty_index": {
    es: "El índice está vacío. Corré `rag index` primero.",
    en: "Index is empty. Run `rag index` first.",
  },
  "panel.wikilinks.empty.not_found": {
    es: "Esta nota no existe en el vault.",
    en: "This note doesn't exist in the vault.",
  },
  "panel.wikilinks.apply": {
    es: "▶ Aplicar",
    en: "▶ Apply",
  },
  "panel.wikilinks.applied": {
    es: "✓ Aplicado",
    en: "✓ Applied",
  },
  "panel.wikilinks.line": {
    es: "línea",
    en: "line",
  },
  "panel.wikilinks.note_changed": {
    es: "Cambiaste de nota — cancelo el aplicar.",
    en: "Active note changed — apply cancelled.",
  },
  "panel.wikilinks.no_editor": {
    es: "No hay editor activo para aplicar.",
    en: "No active editor to apply.",
  },
  "panel.wikilinks.offset_invalid": {
    es: "La posición ya no es válida (texto cambió).",
    en: "Offset no longer valid (text changed).",
  },
  "panel.wikilinks.text_changed": {
    es: "El texto en esa posición cambió",
    en: "Text at that position changed",
  },

  // Panel: Semantic Search ───────────────────────────
  "panel.semantic.title": {
    es: "Búsqueda semántica",
    en: "Semantic search",
  },
  "panel.semantic.placeholder": {
    es: "Pregunta o frase para buscar...",
    en: "Question or phrase to search...",
  },
  "panel.semantic.action_use_selection": {
    es: "Usar selección actual",
    en: "Use current selection",
  },
  "panel.semantic.action_use_note": {
    es: "Usar nota completa",
    en: "Use full note",
  },
  "panel.semantic.empty": {
    es: "Sin resultados. Probá con otra frase o palabra clave.",
    en: "No results. Try another phrase or keyword.",
  },
  "panel.semantic.loading": {
    es: "Buscando...",
    en: "Searching...",
  },

  // Errors / status ──────────────────────────────────
  "error.backend_unavailable": {
    es: "Backend RAG no disponible. Verificá que el web server esté corriendo o ajustá el transport en Settings.",
    en: "RAG backend unavailable. Check the web server is running or change transport in Settings.",
  },
  "error.timeout": {
    es: "Timeout buscando datos. Probá refrescar.",
    en: "Timeout fetching data. Try refreshing.",
  },
  "error.unknown": {
    es: "Error inesperado",
    en: "Unexpected error",
  },

  // Settings ─────────────────────────────────────────
  "settings.section.backend": {
    es: "Backend",
    en: "Backend",
  },
  "settings.section.panels": {
    es: "Paneles",
    en: "Panels",
  },
  "settings.section.appearance": {
    es: "Apariencia",
    en: "Appearance",
  },
  "settings.backend_mode.name": {
    es: "Modo de backend",
    en: "Backend mode",
  },
  "settings.backend_mode.desc": {
    es: "Cómo elegir el transport. 'Auto' prueba HTTP → CLI → MCP en cascada con health check.",
    en: "How to pick the transport. 'Auto' tries HTTP → CLI → MCP in cascade with health check.",
  },
  "settings.http_url.name": {
    es: "URL del web server",
    en: "Web server URL",
  },
  "settings.http_url.desc": {
    es: "URL completa del web server local. Default cubre la instalación estándar.",
    en: "Full URL of the local web server. Default covers the standard install.",
  },
  "settings.rag_binary.name": {
    es: "Path del binario `rag`",
    en: "`rag` binary path",
  },
  "settings.rag_binary.desc": {
    es: "Path absoluto al CLI. Usado cuando el backend cae al CLI fallback.",
    en: "Absolute path to the CLI. Used when the backend falls back to CLI.",
  },
  "settings.mcp_binary.name": {
    es: "Path del binario `obsidian-rag-mcp`",
    en: "`obsidian-rag-mcp` binary path",
  },
  "settings.mcp_binary.desc": {
    es: "Path absoluto al MCP server. Usado por búsqueda semántica y como fallback final.",
    en: "Absolute path to the MCP server. Used by semantic search and as the final fallback.",
  },
  "settings.timeout.name": {
    es: "Timeout de query (ms)",
    en: "Query timeout (ms)",
  },
  "settings.top_k.name": {
    es: "Resultados por panel (top-k)",
    en: "Results per panel (top-k)",
  },
  "settings.language.name": {
    es: "Idioma",
    en: "Language",
  },
  "settings.panel.enabled": {
    es: "Habilitado",
    en: "Enabled",
  },
  "settings.section.filters": {
    es: "Filtros del vault",
    en: "Vault filters",
  },
  "settings.excluded_folders.name": {
    es: "Carpetas excluidas",
    en: "Excluded folders",
  },
  "settings.excluded_folders.desc": {
    es: "Una carpeta por línea (vault-relative, sin / al final). Las notas que vivan adentro de estas carpetas no van a aparecer en \"Notas relacionadas\", \"Contradicciones\" ni \"Wikilinks sugeridos\". Útil para que el archivo (04-Archive) o el inbox sin curar (00-Inbox) no contaminen las sugerencias. Loops abiertos NO se filtran (los items son strings dentro de la nota actual).",
    en: "One folder per line (vault-relative, no trailing /). Notes inside these folders won't appear in \"Related notes\", \"Contradictions\" nor \"Suggested wikilinks\". Useful to keep archive (04-Archive) or uncurated inbox (00-Inbox) out of suggestions. Open loops are NOT filtered (items are strings inside the current note).",
  },
  "settings.excluded_folders.placeholder": {
    es: "04-Archive\n00-Inbox",
    en: "04-Archive\n00-Inbox",
  },
};

/**
 * Lookup con fallback a inglés. Las claves sin traducción devuelven la
 * key tal cual (señal visible en runtime de string falta — preferimos esto
 * sobre fallar silenciosamente con string vacía).
 */
export function t(key: string): string {
  const entry = STRINGS[key];
  if (!entry) return key;
  return entry[_activeLang] ?? entry.en ?? key;
}
