/**
 * Tests del AutoBackend — el cerebro del transport mixto.
 *
 * Estos son los tests más críticos del plugin: si el fallback no
 * funciona, el sidebar se rompe en cuanto el web server cae. Son los
 * más representativos del valor real de la arquitectura "tres
 * backends en cascada".
 *
 * Cubre:
 *   - HTTP responde → no se llama a CLI / MCP.
 *   - HTTP cae → se llama a CLI; si CLI cae → se llama a MCP.
 *   - Todos caen → propaga el último error.
 *   - NotSupportedError no marca el backend como down — sigue al
 *     siguiente sin penalizarlo en el cache de health.
 *   - healthCheck del Auto = OR de los hijos.
 */
import { describe, test, expect, beforeEach } from "bun:test";
import { AutoBackend } from "../src/api/auto";
import {
  type BackendHealth,
  NotSupportedError,
  type RagBackend,
  type RelatedResponse,
  type SemanticHit,
} from "../src/api/types";

class FakeBackend implements RagBackend {
  readonly name: string;
  health: BackendHealth = { available: true };
  callCount = 0;
  // Behavior overrides — definí qué hace cada método cuando se llama.
  getRelatedFn: () => Promise<RelatedResponse> = async () => ({
    items: [],
    source_path: "",
  });
  semanticSearchFn: () => Promise<SemanticHit[]> = async () => [];

  constructor(name: string) {
    this.name = name;
  }

  async healthCheck(): Promise<BackendHealth> {
    return this.health;
  }
  async getRelated(): Promise<RelatedResponse> {
    this.callCount++;
    return this.getRelatedFn();
  }
  async semanticSearch(): Promise<SemanticHit[]> {
    this.callCount++;
    return this.semanticSearchFn();
  }
  async close(): Promise<void> {}
}

let http: FakeBackend;
let cli: FakeBackend;
let mcp: FakeBackend;
let auto: AutoBackend;

beforeEach(() => {
  http = new FakeBackend("http");
  cli = new FakeBackend("cli");
  mcp = new FakeBackend("mcp");
  auto = new AutoBackend([http, cli, mcp], { healthCacheTtlMs: 1_000 });
});

describe("AutoBackend.getRelated", () => {
  test("happy path: HTTP responde → CLI/MCP nunca se llaman", async () => {
    http.getRelatedFn = async () => ({
      items: [{ path: "x.md", note: "x", folder: "", tags: [], shared_tags: [], score: 1, reason: "tags" }],
      source_path: "src.md",
    });
    const resp = await auto.getRelated("src.md", 5);
    expect(resp.items.length).toBe(1);
    expect(http.callCount).toBe(1);
    expect(cli.callCount).toBe(0);
    expect(mcp.callCount).toBe(0);
  });

  test("HTTP throws → CLI fallback", async () => {
    http.getRelatedFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    cli.getRelatedFn = async () => ({
      items: [{ path: "y.md", note: "y", folder: "", tags: [], shared_tags: [], score: 1, reason: "tags" }],
      source_path: "src.md",
    });
    const resp = await auto.getRelated("src.md", 5);
    expect(resp.items[0].path).toBe("y.md");
    expect(http.callCount).toBe(1);
    expect(cli.callCount).toBe(1);
    expect(mcp.callCount).toBe(0);
  });

  test("HTTP + CLI throw → MCP fallback", async () => {
    http.getRelatedFn = async () => {
      throw new Error("HTTP timeout");
    };
    cli.getRelatedFn = async () => {
      throw new Error("ENOENT");
    };
    mcp.getRelatedFn = async () => ({
      items: [{ path: "z.md", note: "z", folder: "", tags: [], shared_tags: [], score: 1, reason: "tags" }],
      source_path: "src.md",
    });
    const resp = await auto.getRelated("src.md", 5);
    expect(resp.items[0].path).toBe("z.md");
    expect(http.callCount).toBe(1);
    expect(cli.callCount).toBe(1);
    expect(mcp.callCount).toBe(1);
  });

  test("todos throw → último error propagado", async () => {
    http.getRelatedFn = async () => { throw new Error("err-http"); };
    cli.getRelatedFn = async () => { throw new Error("err-cli"); };
    mcp.getRelatedFn = async () => { throw new Error("err-mcp"); };
    await expect(auto.getRelated("src.md", 5)).rejects.toThrow("err-mcp");
  });

  test("backend marcado down se saltea sin invocar", async () => {
    http.health = { available: false, error: "down" };
    cli.getRelatedFn = async () => ({
      items: [],
      source_path: "src.md",
    });
    await auto.getRelated("src.md", 5);
    expect(http.callCount).toBe(0); // No invocado — health cached down.
    expect(cli.callCount).toBe(1);
  });
});

describe("AutoBackend.semanticSearch", () => {
  test("HTTP/CLI tiran NotSupportedError — saltan a MCP sin marcar down", async () => {
    http.semanticSearchFn = async () => {
      throw new NotSupportedError("http", "semanticSearch");
    };
    cli.semanticSearchFn = async () => {
      throw new NotSupportedError("cli", "semanticSearch");
    };
    mcp.semanticSearchFn = async () => [
      { path: "x.md", note: "x", score: 0.9, content: "snippet" },
    ];
    const hits = await auto.semanticSearch("hello", 5);
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe("x.md");
    expect(http.callCount).toBe(1);
    expect(cli.callCount).toBe(1);
    expect(mcp.callCount).toBe(1);

    // Crítico: HTTP/CLI siguen disponibles para getRelated después.
    http.getRelatedFn = async () => ({
      items: [{ path: "next.md", note: "next", folder: "", tags: [], shared_tags: [], score: 1, reason: "tags" }],
      source_path: "src.md",
    });
    const resp = await auto.getRelated("src.md", 5);
    expect(resp.items[0].path).toBe("next.md");
    expect(http.callCount).toBe(2); // HTTP fue invocado de nuevo, no marcado down por NotSupported.
  });
});

describe("AutoBackend.healthCheck", () => {
  test("available=true si AL MENOS uno está vivo", async () => {
    http.health = { available: false };
    cli.health = { available: true, latencyMs: 50 };
    mcp.health = { available: false };
    const h = await auto.healthCheck();
    expect(h.available).toBe(true);
    expect(h.latencyMs).toBe(50);
  });

  test("available=false si todos están down", async () => {
    http.health = { available: false, error: "ECONN" };
    cli.health = { available: false, error: "ENOENT" };
    mcp.health = { available: false, error: "no binary" };
    const h = await auto.healthCheck();
    expect(h.available).toBe(false);
    expect(h.error).toContain("todos los backends down");
  });
});
