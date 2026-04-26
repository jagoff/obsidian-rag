/**
 * Tests del parser parseHits — heredados del v0.1.0, intactos. Es
 * crítico que la response del MCP `rag_query` se interprete bien:
 * cualquier regression rompe el SemanticSearchPanel y el McpBackend.
 *
 * Cobertura:
 *   - Response sin shape esperada → [] (no throw).
 *   - Response con campos alternativos (file vs path, rerank_score vs
 *     score, text vs content) → mapping correcto.
 *   - JSON inválido en el text block → [] (no throw).
 *   - tags no-array se ignora (defensa contra responses malformadas).
 */
import { describe, test, expect } from "bun:test";
import { parseHits } from "../main";

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
    // Quirk preservado del v0.1.0: `note` falla a la ref del *campo* `path`,
    // no al *resolved* path. Cuando solo está `h.file` set, ambos `h.note` y
    // `h.path` son undefined → note ends up "". Documenting actual behavior.
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
          text: JSON.stringify([
            { path: "x.md", note: "x", score: 1, content: "", tags: "not-array" },
          ]),
        },
      ],
    };
    const [hit] = parseHits(resp);
    expect(hit.tags).toBeUndefined();
  });
});
