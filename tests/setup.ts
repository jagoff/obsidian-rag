// Bun preload: replace the types-only `obsidian` package with a runtime stub
// before any test file imports main.ts (which imports from "obsidian").
// Also stubs the MCP SDK so tests can exercise runQuery() without spawning
// a real stdio process.
import { mock } from "bun:test";
import * as stub from "./obsidian-stub";
import * as mcp from "./mcp-stub";

mock.module("obsidian", () => stub);
mock.module("@modelcontextprotocol/sdk/client/index.js", () => ({
  Client: mcp.Client,
}));
mock.module("@modelcontextprotocol/sdk/client/stdio.js", () => ({
  StdioClientTransport: mcp.StdioClientTransport,
}));
