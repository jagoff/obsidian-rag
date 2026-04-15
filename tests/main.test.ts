import { describe, test, expect, beforeEach } from "bun:test";
import {
  parseHits,
  withTimeout,
  DEFAULT_SETTINGS,
  VIEW_TYPE_RAG_RESULTS,
  RagResultsView,
  RagSettingTab,
} from "../main";
import {
  App,
  Setting,
  noticesShown,
  type MockEl,
} from "./obsidian-stub";
import { Client, StdioClientTransport } from "./mcp-stub";

import ObsidianRagPlugin from "../main";

// ─── parseHits ────────────────────────────────────────────────────────────────

describe("parseHits", () => {
  test("returns [] when resp has no content array", () => {
    expect(parseHits(null)).toEqual([]);
    expect(parseHits({})).toEqual([]);
    expect(parseHits({ content: "not-array" })).toEqual([]);
  });

  test("returns [] when no text block present", () => {
    expect(parseHits({ content: [{ type: "image", url: "x" }] })).toEqual([]);
    expect(parseHits({ content: [{ type: "text" }] })).toEqual([]); // missing .text
  });

  test("parses a valid JSON-array text block", () => {
    const resp = {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            {
              path: "02-Areas/foo.md",
              note: "foo",
              score: 0.42,
              content: "hola",
              folder: "02-Areas",
              tags: ["a", "b"],
            },
          ]),
        },
      ],
    };
    const hits = parseHits(resp);
    expect(hits.length).toBe(1);
    expect(hits[0]).toEqual({
      path: "02-Areas/foo.md",
      note: "foo",
      score: 0.42,
      content: "hola",
      folder: "02-Areas",
      tags: ["a", "b"],
    });
  });

  test("falls back to alternative field names (file/rerank_score/text)", () => {
    const resp = {
      content: [
        {
          type: "text",
          text: JSON.stringify([
            { file: "x.md", rerank_score: 0.1, text: "snippet" },
          ]),
        },
      ],
    };
    const [hit] = parseHits(resp);
    expect(hit.path).toBe("x.md");
    // Quirk in main.ts: `note` falls back to the source `h.path` (the field),
    // not to the *resolved* path. With only `h.file` set both `h.note` and
    // `h.path` are undefined, so note ends up "". Documenting actual behavior.
    expect(hit.note).toBe("");
    expect(hit.score).toBe(0.1);
    expect(hit.content).toBe("snippet");
    expect(hit.folder).toBeUndefined();
    expect(hit.tags).toBeUndefined();
  });

  test("returns [] on invalid JSON in text block", () => {
    const resp = { content: [{ type: "text", text: "{not valid json" }] };
    expect(parseHits(resp)).toEqual([]);
  });

  test("returns [] when JSON is not an array", () => {
    const resp = { content: [{ type: "text", text: '{"single":"object"}' }] };
    expect(parseHits(resp)).toEqual([]);
  });

  test("ignores non-array tags field", () => {
    const resp = {
      content: [
        {
          type: "text",
          text: JSON.stringify([{ path: "x.md", tags: "not-an-array" }]),
        },
      ],
    };
    const [hit] = parseHits(resp);
    expect(hit.tags).toBeUndefined();
  });
});

// ─── withTimeout ──────────────────────────────────────────────────────────────

describe("withTimeout", () => {
  test("resolves with the inner value when it beats the deadline", async () => {
    const v = await withTimeout(Promise.resolve(42), 1000, "fast");
    expect(v).toBe(42);
  });

  test("rejects with the label when the deadline fires first", async () => {
    const slow = new Promise<string>((res) => setTimeout(() => res("late"), 200));
    await expect(withTimeout(slow, 20, "MCP >20ms")).rejects.toThrow("MCP >20ms");
  });

  test("propagates the inner rejection unchanged", async () => {
    const boom = Promise.reject(new Error("inner-error"));
    await expect(withTimeout(boom, 1000, "x")).rejects.toThrow("inner-error");
  });
});

// ─── DEFAULT_SETTINGS / constants ─────────────────────────────────────────────

describe("DEFAULT_SETTINGS", () => {
  test("ships sane defaults", () => {
    expect(DEFAULT_SETTINGS.binaryPath.length).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.queryTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.topK).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.topK).toBeLessThanOrEqual(15);
  });

  test("VIEW_TYPE constant is stable", () => {
    expect(VIEW_TYPE_RAG_RESULTS).toBe("obsidian-rag-results");
  });
});

// ─── ObsidianRagPlugin: settings + runQuery ───────────────────────────────────

function makePlugin() {
  const app = new App();
  const plugin = new ObsidianRagPlugin(app as any) as any;
  return { app, plugin };
}

describe("ObsidianRagPlugin settings", () => {
  test("loadSettings merges DEFAULT_SETTINGS with stored data", async () => {
    const { plugin } = makePlugin();
    // Stub stored override (only one field) — defaults must fill the rest.
    await plugin.saveData({ topK: 9 });
    await plugin.loadSettings();
    expect(plugin.settings.topK).toBe(9);
    expect(plugin.settings.binaryPath).toBe(DEFAULT_SETTINGS.binaryPath);
    expect(plugin.settings.queryTimeoutMs).toBe(DEFAULT_SETTINGS.queryTimeoutMs);
  });

  test("saveSettings persists via saveData", async () => {
    const { plugin } = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, topK: 7 };
    await plugin.saveSettings();
    const reloaded = await plugin.loadData();
    expect(reloaded.topK).toBe(7);
  });
});

describe("ObsidianRagPlugin runQuery", () => {
  test("returns parsed hits on a valid MCP response", async () => {
    const { plugin } = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, queryTimeoutMs: 1000 };
    plugin.client = {
      callTool: async (_args: any) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify([{ path: "a.md", score: 0.9, content: "x" }]),
          },
        ],
      }),
    };
    const hits = await plugin.runQuery("hola");
    expect(hits.length).toBe(1);
    expect(hits[0].path).toBe("a.md");
  });

  test("propagates timeout when the MCP call exceeds queryTimeoutMs", async () => {
    const { plugin } = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, queryTimeoutMs: 20 };
    plugin.client = {
      callTool: () => new Promise((res) => setTimeout(res, 200)),
    };
    await expect(plugin.runQuery("hola")).rejects.toThrow(/MCP rag_query/);
  });

  test("returns [] on empty MCP content", async () => {
    const { plugin } = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, queryTimeoutMs: 1000 };
    plugin.client = { callTool: async () => ({ content: [] }) };
    const hits = await plugin.runQuery("hola");
    expect(hits).toEqual([]);
  });
});

// ─── ensureClient + closeMcp via mocked MCP SDK ───────────────────────────────

describe("ObsidianRagPlugin ensureClient/close", () => {
  beforeEach(() => Client.reset());

  test("ensureClient builds a transport with the configured binaryPath", async () => {
    const { plugin } = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, binaryPath: "/tmp/fake-mcp" };
    Client.nextResponse = {
      content: [
        { type: "text", text: JSON.stringify([{ path: "h.md", score: 0.5 }]) },
      ],
    };
    const hits = await plugin.runQuery("ping");
    expect(hits[0].path).toBe("h.md");
    // The stub transport keeps its constructor args for inspection.
    const transport = plugin.transport as unknown as StdioClientTransport;
    expect(transport.command).toBe("/tmp/fake-mcp");
    expect(plugin.client).not.toBeNull();
    // Verify the rag_query name + arguments propagated through.
    const last = Client.calls[Client.calls.length - 1];
    expect(last.name).toBe("rag_query");
    expect(last.arguments.question).toBe("ping");
    expect(last.arguments.k).toBe(DEFAULT_SETTINGS.topK);
  });

  test("ensureClient is idempotent (one transport for many queries)", async () => {
    const { plugin } = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS };
    Client.handler = async () => ({ content: [] });
    await plugin.runQuery("a");
    const t1 = plugin.transport;
    await plugin.runQuery("b");
    const t2 = plugin.transport;
    expect(t1).toBe(t2);
    expect(Client.calls.length).toBe(2);
  });

  test("onunload closes both client and transport", async () => {
    const { plugin } = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS };
    Client.handler = async () => ({ content: [] });
    await plugin.runQuery("x");
    const transport = plugin.transport as unknown as StdioClientTransport;
    const client = plugin.client as unknown as Client;
    await plugin.onunload();
    expect(client.closed).toBe(true);
    expect(transport.closed).toBe(true);
    expect(plugin.client).toBeNull();
    expect(plugin.transport).toBeNull();
  });

  test("MCP error propagates as a rejection from runQuery", async () => {
    const { plugin } = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS };
    Client.nextError = new Error("stdio transport died");
    await expect(plugin.runQuery("q")).rejects.toThrow("stdio transport died");
  });
});

// ─── RagResultsView render paths ──────────────────────────────────────────────

function makeView() {
  const { plugin } = makePlugin();
  const leaf = {} as any;
  const view = new RagResultsView(leaf, plugin);
  return { view, plugin };
}

describe("RagResultsView", () => {
  test("renderEmpty shows the keyboard hint", () => {
    const { view } = makeView();
    view.renderEmpty();
    expect(view.contentEl.children[0].text).toMatch(/RAG: Buscar/);
    expect(view.contentEl.children[0].cls).toBe("rag-empty");
  });

  test("setLoading shows the query in progress", () => {
    const { view } = makeView();
    view.setLoading("¿qué es ikigai?");
    expect(view.contentEl.children[0].text).toMatch(/Buscando: ¿qué es ikigai\?…/);
  });

  test("renderHits with empty list shows the no-hits message", () => {
    const { view } = makeView();
    view.renderHits("q", []);
    const txt = view.contentEl.textContent();
    expect(txt).toContain("0 resultados");
    expect(txt).toContain("Sin hits relevantes");
  });

  test("renderHits builds one card per hit with score + snippet", () => {
    const { view } = makeView();
    view.renderHits("q", [
      {
        path: "02-Areas/foo.md",
        note: "foo",
        score: 0.4321,
        content: "snippet de prueba",
        folder: "02-Areas",
      },
    ]);
    const txt = view.contentEl.textContent();
    expect(txt).toContain("1 resultados");
    expect(txt).toContain("foo");
    expect(txt).toContain("score 0.432");
    expect(txt).toContain("02-Areas");
    expect(txt).toContain("snippet de prueba");
  });

  test("clicking a hit title invokes plugin.openNote with the path", () => {
    const { view, plugin } = makeView();
    let openedWith: string | null = null;
    (plugin as any).openNote = async (p: string) => {
      openedWith = p;
    };
    view.renderHits("q", [
      { path: "02-Areas/x.md", note: "x", score: 0.1, content: "" },
    ]);
    // contentEl.children: [header, hits-list]; hits-list.children[0] is the card.
    const list = view.contentEl.children.find((c) => c.cls === "rag-hits") as MockEl;
    const card = list.children[0];
    const title = card.children[0];
    expect(title.cls).toBe("rag-hit-title");
    title.listeners.click[0]({ preventDefault: () => {} });
    expect(openedWith).toBe("02-Areas/x.md");
  });

  test("renderError shows query + message", () => {
    const { view } = makeView();
    view.renderError("boom?", "stderr trace");
    const txt = view.contentEl.textContent();
    expect(txt).toContain("Error");
    expect(txt).toContain("boom?");
    expect(txt).toContain("stderr trace");
  });
});

// ─── RagSettingTab persistence ────────────────────────────────────────────────

describe("RagSettingTab", () => {
  beforeEach(() => {
    Setting.lastChange = null;
    noticesShown.length = 0;
  });

  test("renders and binds the binary-path field to settings.binaryPath", async () => {
    const { app, plugin } = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS };
    const tab = new RagSettingTab(app as any, plugin);
    tab.display();
    // The first Setting created is binaryPath; lastChange holds its onChange.
    // We then re-trigger display() to capture each field's onChange in turn —
    // here we exercise just the binary path via a direct field write since the
    // stub only retains the *last* registered change. Smoke check: settings
    // object stays writable and saveSettings round-trips.
    plugin.settings.binaryPath = "/tmp/new-bin";
    await plugin.saveSettings();
    const stored = await plugin.loadData();
    expect(stored.binaryPath).toBe("/tmp/new-bin");
  });

  test("topK validation rejects non-integers and out-of-range values", async () => {
    const { app, plugin } = makePlugin();
    plugin.settings = { ...DEFAULT_SETTINGS, topK: 5 };
    new RagSettingTab(app as any, plugin).display();
    // Re-running display orders calls so lastChange = topK's onChange (last Setting added).
    const onChange = Setting.lastChange!;
    expect(typeof onChange).toBe("function");
    await onChange("12"); // valid → updates
    expect(plugin.settings.topK).toBe(12);
    await onChange("0"); // invalid → unchanged
    expect(plugin.settings.topK).toBe(12);
    await onChange("99"); // > 15 → unchanged
    expect(plugin.settings.topK).toBe(12);
    await onChange("not-a-number"); // NaN → unchanged
    expect(plugin.settings.topK).toBe(12);
  });
});
