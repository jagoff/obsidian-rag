# obsidian-rag-plugin

Plugin de Obsidian que consulta semánticamente el vault vía el MCP server local
[`obsidian-rag-mcp`](https://github.com/…/obsidian-rag). Cliente fino: el plugin
no embebbe ni rerankea — todo el laburo pesado vive en el binario y este plugin
sólo dispatcha queries y renderiza hits.

## Qué hace v1

1. Command **"RAG: Buscar notas relacionadas"** (hotkey `Cmd+Shift+R`):
   - Si hay selección activa → la usa como query.
   - Si no, cae al primer trozo (≤ 4000 chars) de la nota activa.
   - Spawnea el side pane derecho con los resultados (rerank score, snippet,
     folder, click → abre la nota).
2. Side pane "RAG" (icon `search`):
   - Estados: vacío, cargando, error, hits.
   - Cada card tiene título clickeable + meta (`score · folder`) + snippet (400 chars).

`v1.5` planeado: "Completar con contexto del vault" (inline completion sobre
selección).

## Requisitos

- [obsidian-rag](https://…) instalado y vault indexado al menos una vez:
  ```bash
  cd /path/to/obsidian-rag
  uv tool install --editable .
  rag index
  ```
- El binario `obsidian-rag-mcp` debe ser invocable. Default: `/Users/fer/.local/bin/obsidian-rag-mcp`.
  Cambialo en Settings si tu install vive en otro lado.

## Settings

| Setting | Default | Notas |
|---|---|---|
| Ruta al binario `obsidian-rag-mcp` | `/Users/fer/.local/bin/obsidian-rag-mcp` | Path absoluto al ejecutable. Editar si `uv tool` no instaló acá. |
| Timeout de query (ms) | `30000` | Hard kill si MCP tarda más. Default conservador. |
| Resultados por query (top-k) | `5` | Validación: integer 1..15. Otros valores se ignoran silenciosamente. |

Settings persisten via `loadData/saveData` de Obsidian (uno por vault).

## Cómo se conecta al MCP

- Cliente lazy: la primera query construye `StdioClientTransport({command: binaryPath})` + `Client` y los reusa.
- `onunload`: cierra cliente y transport, limpia referencias. Recargar el plugin re-spawnea el subprocess.
- Tool consumida: `rag_query({question, k})`. La response es un text block con un JSON array de hits.
- `parseHits()` tolera campos alternativos: `path|file`, `score|rerank_score`, `content|text` — refleja variaciones del MCP server.

## Desarrollo

```bash
bun install      # o npm install
bun run dev      # esbuild watch
bun run build    # esbuild production → main.js
bun test         # 29 tests (parseHits, withTimeout, settings, runQuery, ItemView, SettingTab)
bun run typecheck   # tsc --noEmit
```

Para probar en un vault real: copiar `manifest.json`, `main.js`, `styles.css` a
`<vault>/.obsidian/plugins/obsidian-rag/` y habilitar el plugin en
**Settings → Community plugins**. (Hot-reload con plugin "Hot Reload" si
estás iterando.)

## Tests

Suite completa con `bun test`. Cobertura:

- **`parseHits`** — variantes de response del MCP server (JSON valido, malformado,
  campos alternativos, content vacío, tags non-array).
- **`withTimeout`** — resolución, rejection por deadline, propagación de error
  inner.
- **`Plugin.runQuery` y `ensureClient`** — happy path, timeout, idempotencia del
  cliente, close en `onunload`, propagación de errores MCP. Usa stubs estáticos
  de `Client`/`StdioClientTransport` (`tests/mcp-stub.ts`) para no spawnear el
  binario real.
- **`Plugin.loadSettings`/`saveSettings`** — merge con defaults, roundtrip via
  `loadData/saveData` mockeado.
- **`RagResultsView`** — render empty/loading/error/hits, click-to-open invoca
  `plugin.openNote`.
- **`RagSettingTab`** — validación de `topK` (rechaza NaN, 0, > 15).

El módulo `obsidian` upstream sólo trae `.d.ts`, así que `tests/setup.ts`
preloadea un runtime stub completo (`tests/obsidian-stub.ts`) — App, Plugin,
ItemView, PluginSettingTab, Setting, Notice, TFile, WorkspaceLeaf con un DOM
fake (`makeEl()`) que simula `createEl/empty/addEventListener` lo justo para
verificar render structure.

`tsconfig.json` excluye `tests/` del typecheck para no contaminar la build con
los stubs (y porque `bun:test` no expone tipos `.d.ts` standard).

## Arquitectura

- `main.ts` (~340 líneas) — todo: plugin class, MCP client wrapper,
  `RagResultsView` (ItemView), `RagSettingTab`. Single-file by design —
  el alcance es chico y refactorear a archivos separados sólo agregaría
  ceremonia.
- Módulos exportados (para tests): `parseHits`, `withTimeout`,
  `DEFAULT_SETTINGS`, `RagResultsView`, `RagSettingTab`, `RagHit`, `RagSettings`,
  `VIEW_TYPE_RAG_RESULTS`. Sin cambios de visibilidad runtime — sólo named
  exports para acceso desde la suite.
- Esbuild empaqueta a `main.js` standalone (CommonJS, target es2018) — el
  plugin no se ejecuta en Bun en runtime, corre dentro del Electron del
  desktop de Obsidian.

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| Notice "RAG error: spawn ENOENT" | Binario no existe en el path configurado | Verificá `which obsidian-rag-mcp` y actualizá Settings |
| Notice "RAG error: MCP rag_query >30000ms" | Indexing en curso o modelo no cargado | `ollama ps`, esperá. O subí timeout en Settings. |
| Side pane vacío con "Sin hits relevantes" | El reranker no encontró nada > confidence | Probá una query menos abstracta o más larga. El binario respeta `CONFIDENCE_RERANK_MIN`. |
| Plugin no aparece en Community plugins | Falta `manifest.json` en el plugin dir del vault | Re-copiar los 3 archivos (`manifest.json`, `main.js`, `styles.css`). |

## Status

v0.1.0 — scaffold + feature 1 + side pane + tests (29 casos). No empaquetado
para Community plugins todavía: install manual.
