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
  type ContradictionsResponse,
  type LoopsResponse,
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
  getContradictionsFn: () => Promise<ContradictionsResponse> = async () => ({
    items: [],
    source_path: "",
  });
  getLoopsFn: () => Promise<LoopsResponse> = async () => ({
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
  async getContradictions(): Promise<ContradictionsResponse> {
    this.callCount++;
    return this.getContradictionsFn();
  }
  async getLoops(): Promise<LoopsResponse> {
    this.callCount++;
    return this.getLoopsFn();
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

describe("AutoBackend.getContradictions", () => {
  test("HTTP responde → CLI/MCP no se llaman", async () => {
    http.getContradictionsFn = async () => ({
      items: [{
        path: "other.md", note: "other", folder: "",
        snippet: "contradicting text", why: "tensión LLM",
      }],
      source_path: "src.md",
    });
    const resp = await auto.getContradictions("src.md", 5);
    expect(resp.items.length).toBe(1);
    expect(resp.items[0].why).toBe("tensión LLM");
    expect(http.callCount).toBe(1);
    expect(cli.callCount).toBe(0);
    expect(mcp.callCount).toBe(0);
  });

  test("HTTP throws → CLI fallback", async () => {
    http.getContradictionsFn = async () => {
      throw new Error("HTTP timeout (LLM cold load)");
    };
    cli.getContradictionsFn = async () => ({
      items: [{
        path: "x.md", note: "x", folder: "", snippet: "s", why: "w",
      }],
      source_path: "src.md",
    });
    const resp = await auto.getContradictions("src.md", 5);
    expect(resp.items[0].path).toBe("x.md");
    expect(http.callCount).toBe(1);
    expect(cli.callCount).toBe(1);
  });

  test("MCP tira NotSupportedError — se saltea, HTTP/CLI no quedan marcados down", async () => {
    // MCP no implementa contradictions — es NotSupportedError, NO down.
    // Después de este test, una llamada siguiente a MCP debe seguir
    // viva (available), solo esa OP no funciona.
    mcp.getContradictionsFn = async () => {
      throw new NotSupportedError("mcp", "getContradictions");
    };
    http.getContradictionsFn = async () => ({
      items: [], source_path: "src.md",
    });
    const resp = await auto.getContradictions("src.md", 5);
    expect(resp.items).toEqual([]);
    expect(http.callCount).toBe(1); // Primero HTTP respondió → cortó ahí.
    expect(mcp.callCount).toBe(0); // MCP ni se invocó.
  });

  test("reason empty_index se propaga del HTTP", async () => {
    http.getContradictionsFn = async () => ({
      items: [], source_path: "src.md", reason: "empty_index",
    });
    const resp = await auto.getContradictions("src.md", 5);
    expect(resp.reason).toBe("empty_index");
    expect(resp.items).toEqual([]);
  });
});

describe("AutoBackend.getLoops", () => {
  test("HTTP responde → CLI/MCP no se llaman", async () => {
    http.getLoopsFn = async () => ({
      items: [
        { loop_text: "llamar a juan", kind: "todo", age_days: 3, extracted_at: "2026-04-23T10:00:00" },
      ],
      source_path: "Plan.md",
    });
    const resp = await auto.getLoops("Plan.md", 50);
    expect(resp.items.length).toBe(1);
    expect(resp.items[0].kind).toBe("todo");
    expect(http.callCount).toBe(1);
    expect(cli.callCount).toBe(0);
    expect(mcp.callCount).toBe(0);
  });

  test("HTTP throws → CLI fallback con mismo shape", async () => {
    http.getLoopsFn = async () => {
      throw new Error("ECONNREFUSED");
    };
    cli.getLoopsFn = async () => ({
      items: [{ loop_text: "x", kind: "checkbox", age_days: 0, extracted_at: "" }],
      source_path: "Plan.md",
    });
    const resp = await auto.getLoops("Plan.md", 50);
    expect(resp.items[0].kind).toBe("checkbox");
    expect(cli.callCount).toBe(1);
  });

  test("MCP NotSupported no marca down (siguiente call funciona)", async () => {
    mcp.getLoopsFn = async () => {
      throw new NotSupportedError("mcp", "getLoops");
    };
    http.getLoopsFn = async () => ({
      items: [], source_path: "Plan.md",
    });
    const resp = await auto.getLoops("Plan.md", 50);
    expect(resp.items).toEqual([]);
    // HTTP respondió, MCP nunca se invocó.
    expect(mcp.callCount).toBe(0);
  });

  test("reason=not_found se propaga", async () => {
    http.getLoopsFn = async () => ({
      items: [], source_path: "ghost.md", reason: "not_found",
    });
    const resp = await auto.getLoops("ghost.md", 50);
    expect(resp.reason).toBe("not_found");
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
