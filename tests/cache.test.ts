/**
 * Tests del LruCache — cache de respuestas de getRelated por path.
 * Mantenerlo correcto evita que el panel haga refetch en bucle cuando
 * el user clickea entre notas rápido.
 *
 * Cubre:
 *   - Get/set básico.
 *   - TTL expiry: una entrada vencida vuelve undefined.
 *   - LRU evict: pasarse de maxSize bota la más vieja.
 *   - LRU touch: get hace que la entrada se mueva al final del orden.
 *   - Invalidate / clear.
 */
import { describe, test, expect } from "bun:test";
import { LruCache } from "../src/api/cache";

describe("LruCache", () => {
  test("get returns undefined for unknown keys", () => {
    const c = new LruCache<string, number>();
    expect(c.get("x")).toBeUndefined();
  });

  test("set/get roundtrip", () => {
    const c = new LruCache<string, number>();
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
  });

  test("TTL expiry — una entrada vencida vuelve undefined", async () => {
    const c = new LruCache<string, number>({ ttlMs: 10 });
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(c.get("a")).toBeUndefined();
    expect(c.size()).toBe(0); // Auto-evicted al expirar.
  });

  test("LRU evict — pasarse de maxSize bota la más vieja", () => {
    const c = new LruCache<string, number>({ maxSize: 2 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("c", 3); // Excede; "a" debería ser evicted.
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
    expect(c.get("c")).toBe(3);
  });

  test("LRU touch — get reordena al final", () => {
    const c = new LruCache<string, number>({ maxSize: 2 });
    c.set("a", 1);
    c.set("b", 2);
    // Touch "a" — ahora "b" es el más viejo.
    expect(c.get("a")).toBe(1);
    c.set("c", 3); // "b" es evicted, no "a".
    expect(c.get("a")).toBe(1);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe(3);
  });

  test("invalidate(key) borra solo esa entrada", () => {
    const c = new LruCache<string, number>();
    c.set("a", 1);
    c.set("b", 2);
    c.invalidate("a");
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBe(2);
  });

  test("clear() vacía todo", () => {
    const c = new LruCache<string, number>();
    c.set("a", 1);
    c.set("b", 2);
    c.clear();
    expect(c.size()).toBe(0);
    expect(c.get("a")).toBeUndefined();
    expect(c.get("b")).toBeUndefined();
  });

  test("re-set sobre key existente refresca el TTL + reordena al final", async () => {
    const c = new LruCache<string, number>({ maxSize: 2, ttlMs: 100 });
    c.set("a", 1);
    c.set("b", 2);
    await new Promise((r) => setTimeout(r, 50));
    c.set("a", 99); // Refresh: nuevo TTL + se mueve al final.
    c.set("c", 3); // "b" es el más viejo ahora, evicted.
    expect(c.get("a")).toBe(99);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("c")).toBe(3);
  });
});
