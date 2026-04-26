# obsidian-rag-plugin

Sidebar extensible para Obsidian que muestra **notas relacionadas, búsqueda
semántica y datos del vault** consumiendo el [obsidian-rag](https://github.com/jagoff/rag-obsidian)
local. Multi-backend: HTTP (web server), CLI (`rag related`) o MCP stdio,
con fallback automático.

> **Status v0.2.0** — refactor mayor. Sidebar plug-and-play, transport
> mixto, 31 tests verdes. No empaquetado para Community plugins todavía:
> install via [BRAT](https://github.com/TfTHacker/obsidian42-brat) o
> manual.

## Qué muestra el sidebar

Stack vertical de paneles colapsables, cada uno reactive a la nota activa
(o manual). Drag-and-drop para reordenar.

### Panel "Notas relacionadas" (default)

Notas vinculadas a la nota activa por **shared tags + graph hops**.
Backend: `find_related` del obsidian-rag (no embedding semántico — usa la
topología real del vault). Reactive: re-fetch en cada cambio de nota
activa.

Cada card:

- Título clickeable (Cmd+click → split-pane).
- Badge con la **razón**: 🟢 link / 🟡 tags / 🟦 ambos.
- Score (int — sumá tags + 2× link edges).
- Chips con los tags compartidos.
- Right-click → menú: abrir, abrir en split, copiar wikilink.

### Panel "Búsqueda semántica"

Manual (Cmd+Shift+R o botón en el panel). Toma una query, una selección
o el contenido completo de la nota activa, y consulta el reranker via
`rag_query` MCP. Útil para "encontrá lo que escribí sobre X" cuando no
recordás el nombre de la nota.

### Roadmap (paneles que vienen)

Cada uno = nuevo archivo en `src/panels/`, mismo `SidebarPanel` API:

- **Backlinks enriched** (con scores, no plano).
- **Loops abiertos** en la nota actual (`find_followup_loops`).
- **Contradicciones detectadas** (`find_contradictions_for_note`).
- **Wikilinks sugeridos** (`suggest_wikilinks`).
- **@Personas + cross-source** (notas + emails + WA + calendar).
- **URLs en la nota** + URLs relacionadas.
- **"Hace N tiempo"** (mismo día N años atrás + matches semánticos).
- **Auto-tags sugeridos** al guardar.
- **Vos mismo del pasado** (self-rubber-duck).
- **Anticipatory signals** para esta nota.
- **Hygiene flags** (vacía, stale, huérfana, sin frontmatter).

## Requisitos

- [obsidian-rag](https://github.com/jagoff/rag-obsidian) instalado y
  vault indexado:
  ```bash
  cd /path/to/obsidian-rag
  uv tool install --editable '.[entities]'
  rag index
  ```
- Web server local corriendo (default `http://127.0.0.1:8765`) o el
  binario `rag` en el PATH para el fallback CLI.

## Instalación

### Vía BRAT (recomendado mientras no hay listing en community store)

1. Instalar el plugin [BRAT](https://github.com/TfTHacker/obsidian42-brat)
   en Obsidian.
2. BRAT → "Add Beta plugin" → pegar
   `https://github.com/jagoff/obsidian-rag-plugin`.
3. Habilitar el plugin en **Settings → Community plugins**.

### Manual

```bash
git clone https://github.com/jagoff/obsidian-rag-plugin.git
cd obsidian-rag-plugin
npm install        # o `bun install`
npm run build
# Copiar manifest.json + main.js + styles.css a:
# <vault>/.obsidian/plugins/obsidian-rag/
```

## Settings

| Sección | Setting | Default | Notas |
|---|---|---|---|
| **Backend** | Modo | `auto` | `auto` (HTTP→CLI→MCP), `http`, `cli`, `mcp` |
| | URL del web server | `http://127.0.0.1:8765` | El web server local de obsidian-rag |
| | Path del binario `rag` | `/Users/<you>/.local/bin/rag` | Para el fallback CLI |
| | Path del binario `obsidian-rag-mcp` | `/Users/<you>/.local/bin/obsidian-rag-mcp` | Para el fallback MCP |
| | Timeout de query (ms) | `30000` | Hard kill si el backend tarda más |
| **Paneles** | Habilitado por panel | `true` | Toggle para apagar paneles |
| | Reset panel order | — | Vuelve al orden default |
| **Apariencia** | Idioma | `es` | `es` (rioplatense) o `en` |
| | Resultados por panel (top-k) | `10` | Integer 1..50 |

## Cómo se conecta al backend

El plugin abstrae los 3 transports detrás de un único `RagBackend`
interface. Cada llamada (`getRelated`, `semanticSearch`) intenta los
backends en orden hasta que uno responde:

```
Auto: HTTP (8765/api/notes/related) → CLI (rag related --json) → MCP (stdio)
```

Si un backend tira un error transitorio (timeout, ECONNREFUSED), el
`AutoBackend` lo marca como down en el cache de health (TTL 30s) y
salta al siguiente. Health checks se hacen en paralelo al cambiar
settings.

`NotSupportedError` (ej. HTTP/CLI no implementan `semanticSearch`) NO
marca el backend como down — solo salta al siguiente para esa op
específica.

## Performance

Medido en vault real (~5400 chunks):

| Path | Tiempo |
|---|---|
| HTTP cold (corpus first-load del web server) | 268ms |
| HTTP warm | ~4ms |
| CLI cold (proceso fresco, click bootstrap) | 365ms |
| MCP cold (subprocess + torch + sentence-transformers load) | 1-2s |

El sidebar cachea respuestas por path con TTL 60s, así cambiando entre
notas en sesión rápida no paga el round-trip.

## Desarrollo

```bash
bun install               # o npm install
bun run dev               # esbuild watch
bun run build             # esbuild production → main.js
bun test                  # 31 tests
bun run typecheck         # tsc --noEmit
```

### Estructura

```
src/
├── api/
│   ├── types.ts          # RagBackend interface, RelatedItem, RagSettings
│   ├── http.ts           # HttpBackend (requestUrl)
│   ├── cli.ts            # CliBackend (child_process.execFile)
│   ├── mcp.ts            # McpBackend (stdio MCP SDK)
│   ├── auto.ts           # AutoBackend (health-check + fallback chain)
│   └── cache.ts          # LruCache con TTL
├── panels/
│   ├── base.ts           # SidebarPanel interface + BasePanel helper
│   ├── related-notes.ts  # FASE 1
│   └── semantic-search.ts # FASE 1 (refactor del v0.1.0 command)
├── utils/
│   ├── debounce.ts
│   ├── parse-hits.ts     # parseHits del MCP response (heredado v0.1.0)
│   └── timeout.ts        # withTimeout (heredado v0.1.0)
├── view.ts               # RagSidebarView (ItemView + stack + drag-reorder)
├── settings.ts           # SettingsTab con secciones
└── i18n.ts               # dict ES/EN

main.ts                   # Plugin entrypoint — orquestador
```

### Agregar un panel nuevo (recipe)

1. Crear `src/panels/<id>.ts`:
   ```ts
   import { BasePanel } from "./base";
   import type { PanelContext, PanelTrigger } from "../api/types";

   export class MyPanel extends BasePanel {
     readonly id = "my-panel";
     readonly titleKey = "panel.my.title";
     readonly icon = "search";  // lucide name
     readonly triggers: PanelTrigger[] = ["active-leaf-change"];

     protected async fetch(ctx: PanelContext) {
       return await ctx.backend.getRelated(ctx.file?.path ?? "", 10);
     }
     protected renderEmpty(body: HTMLElement) {
       body.createEl("div", { text: "vacío" });
     }
     protected renderData(body: HTMLElement, data: unknown) {
       // ...
     }
   }
   ```
2. Agregar el id a `DEFAULT_SETTINGS.panelOrder` y `panelEnabled`.
3. Registrarlo en `main.ts:buildPanels()`.
4. Agregar las claves i18n en `src/i18n.ts`.

## Tests

```bash
bun test
```

Cobertura (31 tests):

- **`parse-hits.test.ts`** (7) — Parser de respuesta MCP `rag_query`,
  variantes válidas + malformadas + campos alternativos.
- **`timeout.test.ts`** (3) — withTimeout: resolve, deadline, propagate.
- **`settings-persistence.test.ts`** (5) — Defaults sanity, load/save
  via Obsidian's `loadData/saveData`, merge nested maps.
- **`cache.test.ts`** (8) — LruCache: get/set, TTL expiry, evict, LRU
  touch, invalidate, clear.
- **`auto-backend.test.ts`** (8) — Fallback chain: HTTP→CLI→MCP, todos
  fallan → último error, NotSupportedError no marca down, healthCheck
  combinado.

Tests usan stubs runtime de `obsidian` y `@modelcontextprotocol/sdk`
(`tests/obsidian-stub.ts`, `tests/mcp-stub.ts`) — no spawnea binarios
reales ni Electron.

## Troubleshooting

| Síntoma | Causa probable | Fix |
|---|---|---|
| Sidebar muestra "Backend RAG no disponible" | Web server caído + CLI no en path | Verificá `lsof -i :8765` y/o `which rag`. Probá el botón "Test connection" en Settings. |
| Notice "RAG error: spawn ENOENT" | Binario MCP no existe en el path configurado | Settings → Path del binario `obsidian-rag-mcp`. `which obsidian-rag-mcp`. |
| Notice "MCP rag_query >30000ms" | El binary tarda en cargar models en cold start | Subir timeout en Settings, o esperar a que ollama termine de cargar el reranker. |
| Notas no aparecen en "Notas relacionadas" | La nota no está indexada (recién creada / `rag watch` apagado) | `cd obsidian-rag && rag index` |
| Drag-reorder no persiste | Settings save falla silencioso | Reload del plugin (Settings → Community plugins → toggle off/on). |
| Tooltip / ícono raro tras update | Cache del bundle viejo | Reload del vault o reinstalar plugin. |

## Versión

`v0.2.0` — refactor del v0.1.0 (que era una sola view + comando manual
con MCP) a sidebar extensible plug-and-play con transport mixto.

## License

MIT — ver `LICENSE`.
