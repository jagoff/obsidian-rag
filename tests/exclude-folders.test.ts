/**
 * Tests del helper client-side para filtrar items por excluded folders.
 * Espeja al backend (web/server.py:_parse_exclude_folders +
 * _is_in_excluded_folder), por eso son las mismas reglas:
 *   - prefix match con trailing "/"
 *   - normalización trim + rstrip "/"
 *   - empty list = no filter
 */
import { describe, expect, test } from "bun:test";
import {
  filterByExcludedFolders,
  isInExcludedFolder,
  parseExcludeFolders,
} from "../src/utils/exclude-folders";

describe("parseExcludeFolders", () => {
  test("undefined → []", () => {
    expect(parseExcludeFolders(undefined)).toEqual([]);
  });

  test("empty array → []", () => {
    expect(parseExcludeFolders([])).toEqual([]);
  });

  test("trim + rstrip / + drop empties", () => {
    expect(
      parseExcludeFolders(["  04-Archive/  ", "00-Inbox", "", "   ", "foo/"]),
    ).toEqual(["04-Archive", "00-Inbox", "foo"]);
  });
});

describe("isInExcludedFolder", () => {
  test("exact match → true", () => {
    expect(isInExcludedFolder("04-Archive", ["04-Archive"])).toBe(true);
  });

  test("prefix match con trailing / → true", () => {
    expect(
      isInExcludedFolder("04-Archive/old/foo.md", ["04-Archive"]),
    ).toBe(true);
  });

  test("prefix sin / no matchea (defensa contra '04-Archive-old/')", () => {
    expect(
      isInExcludedFolder("04-Archive-old/foo.md", ["04-Archive"]),
    ).toBe(false);
  });

  test("no match → false", () => {
    expect(
      isInExcludedFolder("01-Projects/foo.md", ["04-Archive", "00-Inbox"]),
    ).toBe(false);
  });

  test("empty exclude list → false", () => {
    expect(isInExcludedFolder("anywhere/foo.md", [])).toBe(false);
  });
});

describe("filterByExcludedFolders", () => {
  type Item = { path: string; n: number };

  test("empty exclude → devuelve la lista original (no copy)", () => {
    const items: Item[] = [
      { path: "a.md", n: 1 },
      { path: "b.md", n: 2 },
    ];
    const out = filterByExcludedFolders(items, [], (it) => it.path);
    expect(out).toBe(items); // identidad — no se hizo filter
  });

  test("filtra por path", () => {
    const items: Item[] = [
      { path: "01-Projects/keep.md", n: 1 },
      { path: "04-Archive/drop.md", n: 2 },
      { path: "00-Inbox/drop2.md", n: 3 },
      { path: "02-Areas/keep2.md", n: 4 },
    ];
    const out = filterByExcludedFolders(
      items,
      ["04-Archive", "00-Inbox"],
      (it) => it.path,
    );
    expect(out.map((it) => it.n)).toEqual([1, 4]);
  });

  test("accessor genérico — funciona con WikilinkSuggestion (target)", () => {
    type Sugg = { target: string; title: string };
    const items: Sugg[] = [
      { target: "01-Projects/foo.md", title: "Foo" },
      { target: "04-Archive/bar.md", title: "Bar" },
    ];
    const out = filterByExcludedFolders(
      items,
      ["04-Archive"],
      (it) => it.target,
    );
    expect(out).toHaveLength(1);
    expect(out[0].title).toBe("Foo");
  });

  test("normaliza la lista (rstrip /) antes de filtrar", () => {
    const items: Item[] = [
      { path: "04-Archive/foo.md", n: 1 },
      { path: "01-Projects/bar.md", n: 2 },
    ];
    const out = filterByExcludedFolders(
      items,
      ["04-Archive/", " 04-Archive "], // basura → debe normalizar
      (it) => it.path,
    );
    expect(out).toHaveLength(1);
    expect(out[0].n).toBe(2);
  });
});
