/**
 * Tests de withTimeout — heredados del v0.1.0, intactos.
 *
 * El wrapper se usa en McpBackend (rag_query con deadline duro) y
 * cualquier feature futura que necesite race entre promise + timeout.
 * Romper esto = el plugin se cuelga indefinidamente cuando el binary
 * MCP no responde, sin recovery.
 */
import { describe, test, expect } from "bun:test";
import { withTimeout } from "../main";

describe("withTimeout", () => {
  test("resolves with the inner value when it beats the deadline", async () => {
    const result = await withTimeout(Promise.resolve(42), 100, "label");
    expect(result).toBe(42);
  });

  test("rejects with the label when the deadline fires first", async () => {
    const slow = new Promise<number>((res) => setTimeout(() => res(1), 50));
    await expect(withTimeout(slow, 5, "tag")).rejects.toThrow("tag");
  });

  test("propagates the inner rejection unchanged", async () => {
    const failed = Promise.reject(new Error("inner"));
    await expect(withTimeout(failed, 100, "outer")).rejects.toThrow("inner");
  });
});
