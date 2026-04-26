// Bun preload: mockea los módulos que el plugin importa con stubs runtime.
// El paquete `obsidian` solo trae .d.ts y los tests no spawnean Electron;
// el MCP SDK lo stubeamos para no abrir un subprocess real.
//
// Configurado en bunfig.toml via `preload = ["./tests/setup.ts"]`.
import { mock } from "bun:test";
import * as obsidianStub from "./obsidian-stub";
import * as mcpStub from "./mcp-stub";

mock.module("obsidian", () => obsidianStub);
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: mcpStub.Client,
}));
mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: mcpStub.StdioClientTransport,
}));
