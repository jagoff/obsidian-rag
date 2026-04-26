/**
 * Tests de persistencia de settings — heredados del v0.1.0 con shape
 * adaptado al v0.2.0. El test sigue siendo el mismo invariante:
 *   loadSettings merge con DEFAULT_SETTINGS + saveSettings persiste via
 *   loadData/saveData.
 *
 * Cambios vs v0.1.0:
 *   - DEFAULT_SETTINGS ya no tiene `binaryPath` (renombrado +
 *     splitteado en `httpUrl`, `ragBinaryPath`, `mcpBinaryPath`).
 *   - Tiene campos nuevos: backendMode, panelOrder, panelCollapsed,
 *     language. Los tests asseran sobre los nuevos campos.
 */
import { describe, test, expect } from "bun:test";
import { App } from "./obsidian-stub";
import { DEFAULT_SETTINGS } from "../main";
import ObsidianRagPlugin from "../main";

describe("DEFAULT_SETTINGS", () => {
  test("ships sane defaults — backend mode + URL + binarios", () => {
    expect(DEFAULT_SETTINGS.backendMode).toBe("auto");
    expect(DEFAULT_SETTINGS.httpUrl).toBe("http://127.0.0.1:8765");
    expect(DEFAULT_SETTINGS.ragBinaryPath.endsWith("/rag")).toBe(true);
    expect(DEFAULT_SETTINGS.mcpBinaryPath.endsWith("/obsidian-rag-mcp")).toBe(true);
    expect(DEFAULT_SETTINGS.queryTimeoutMs).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.topK).toBeGreaterThan(0);
    expect(DEFAULT_SETTINGS.language).toBe("es");
  });

  test("panel order incluye los dos panels iniciales", () => {
    // Cuando agreguemos paneles nuevos al roadmap, este test asegura que
    // el default settings los registre. Si añadís un panel sin ponerlo
    // acá, el panel no va a aparecer en sidebars de users existentes
    // hasta que toquen settings.
    expect(DEFAULT_SETTINGS.panelOrder).toContain("related-notes");
    expect(DEFAULT_SETTINGS.panelOrder).toContain("semantic-search");
  });
});

describe("ObsidianRagPlugin settings persistence", () => {
  test("loadSettings merges DEFAULT_SETTINGS with stored data", async () => {
    const app = new App();
    const plugin = new ObsidianRagPlugin(app as any, {} as any);
    // Pre-poblar el storage con un override parcial para simular un user
    // que ya tenía settings guardados de una versión previa.
    await plugin.saveData({
      backendMode: "http",
      topK: 20,
      panelOrder: ["semantic-search", "related-notes"], // user reordenó
    });
    await plugin.loadSettings();
    expect(plugin.settings.backendMode).toBe("http");
    expect(plugin.settings.topK).toBe(20);
    expect(plugin.settings.panelOrder).toEqual([
      "semantic-search",
      "related-notes",
    ]);
    // Defaults se preservan para campos no overrideados.
    expect(plugin.settings.queryTimeoutMs).toBe(DEFAULT_SETTINGS.queryTimeoutMs);
    expect(plugin.settings.language).toBe(DEFAULT_SETTINGS.language);
  });

  test("saveSettings persists via saveData", async () => {
    const app = new App();
    const plugin = new ObsidianRagPlugin(app as any, {} as any);
    plugin.settings = {
      ...DEFAULT_SETTINGS,
      topK: 7,
      backendMode: "cli",
    };
    await plugin.saveSettings();
    const stored = await plugin.loadData();
    expect(stored.topK).toBe(7);
    expect(stored.backendMode).toBe("cli");
  });

  test("loadSettings merges nested maps correctamente", async () => {
    const app = new App();
    const plugin = new ObsidianRagPlugin(app as any, {} as any);
    // El user toggleó solo "related-notes" off; el resto debe heredar
    // los defaults.
    await plugin.saveData({
      panelEnabled: { "related-notes": false },
    });
    await plugin.loadSettings();
    expect(plugin.settings.panelEnabled["related-notes"]).toBe(false);
    expect(plugin.settings.panelEnabled["semantic-search"]).toBe(true);
  });
});
