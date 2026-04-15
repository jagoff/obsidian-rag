# obsidian-rag-plugin

Plugin de Obsidian que consulta semánticamente el vault vía el MCP server local `obsidian-rag-mcp` (proyecto [obsidian-rag](https://github.com/…/obsidian-rag)).

## Scope v1

1. Command **"RAG: Buscar notas relacionadas"** (hotkey `Cmd+Shift+R`) — toma la selección actual o la nota entera, llama `rag_query`, muestra resultados clickables en un side pane derecho.
2. Settings: path al binario `obsidian-rag-mcp`, timeout de query, top-k.

Feature "Completar con contexto del vault" (inline completion) → v1.5.

## Requisitos

- [obsidian-rag](https://…) instalado: el CLI `rag` y el binario `obsidian-rag-mcp` deben existir (`uv tool install --editable .` en el repo de obsidian-rag).
- Vault indexado al menos una vez (`rag index`).

## Desarrollo

```bash
npm install
npm run dev      # watch
npm run build    # production → main.js
```

Para probar: copiar `manifest.json`, `main.js`, `styles.css` a `<vault>/.obsidian/plugins/obsidian-rag/` y habilitar el plugin en Settings → Community plugins.

## Arquitectura

- `main.ts` — plugin class, settings, command, ItemView del side pane.
- MCP client vía `@modelcontextprotocol/sdk` (`StdioClientTransport` spawnea `obsidian-rag-mcp`).
- Cliente lazy: se conecta al primer query, se cierra en `onunload`.

## Status

v0.1.0 — scaffold + feature 1 inicial. No empaquetado para Community plugins todavía.
