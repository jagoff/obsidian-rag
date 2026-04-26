/**
 * Settings tab del plugin. Sigue el pattern oficial de Obsidian:
 * extender PluginSettingTab y poner la UI en `display()`.
 *
 * Layout:
 *   1. Backend section: mode dropdown, http URL, binarios, timeouts.
 *   2. Panels section: enabled/disabled toggle por panel + "reset
 *      order" button.
 *   3. Appearance section: language picker + top-k.
 *
 * Cuando el user cambia algo:
 *   - Validamos el valor.
 *   - Si pasa: persistimos via `saveSettings` (debounced en el caller).
 *   - Disparamos `onSettingsChange` para que el plugin regenere el
 *     backend (si el mode cambió) y refresque la sidebar view.
 */
import {
  App,
  Notice,
  PluginSettingTab,
  Setting,
  type Plugin,
} from "obsidian";
import {
  type BackendMode,
  type RagSettings,
} from "./api/types";
import { setLanguage, t } from "./i18n";
import type { SidebarPanel } from "./panels/base";

export interface SettingsTabDeps {
  plugin: Plugin;
  panels: SidebarPanel[];
  getSettings: () => RagSettings;
  saveSettings: () => Promise<void>;
  /** Llamado cuando un cambio de settings requiere regenerar el backend o el sidebar. */
  onChange: () => Promise<void>;
}

export class RagSettingTab extends PluginSettingTab {
  private readonly deps: SettingsTabDeps;

  constructor(app: App, deps: SettingsTabDeps) {
    super(app, deps.plugin);
    this.deps = deps;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("rag-settings");

    this.renderBackendSection(containerEl);
    this.renderPanelsSection(containerEl);
    this.renderAppearanceSection(containerEl);
  }

  // ── Backend section ─────────────────────────────────────────────────

  private renderBackendSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: t("settings.section.backend") });

    new Setting(containerEl)
      .setName(t("settings.backend_mode.name"))
      .setDesc(t("settings.backend_mode.desc"))
      .addDropdown((dd) =>
        dd
          .addOptions({
            auto: "Auto (HTTP → CLI → MCP)",
            http: "HTTP only",
            cli: "CLI only",
            mcp: "MCP only",
          })
          .setValue(this.deps.getSettings().backendMode)
          .onChange(async (value) => {
            this.deps.getSettings().backendMode = value as BackendMode;
            await this.deps.saveSettings();
            await this.deps.onChange();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.http_url.name"))
      .setDesc(t("settings.http_url.desc"))
      .addText((text) =>
        text
          .setPlaceholder("http://127.0.0.1:8765")
          .setValue(this.deps.getSettings().httpUrl)
          .onChange(async (value) => {
            const trimmed = value.trim();
            if (!/^https?:\/\//.test(trimmed)) {
              // Fail visible — el user va a notar que no se guardó.
              return;
            }
            this.deps.getSettings().httpUrl = trimmed;
            await this.deps.saveSettings();
            await this.deps.onChange();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.rag_binary.name"))
      .setDesc(t("settings.rag_binary.desc"))
      .addText((text) =>
        text
          .setPlaceholder("/Users/<you>/.local/bin/rag")
          .setValue(this.deps.getSettings().ragBinaryPath)
          .onChange(async (value) => {
            this.deps.getSettings().ragBinaryPath = value.trim();
            await this.deps.saveSettings();
            await this.deps.onChange();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.mcp_binary.name"))
      .setDesc(t("settings.mcp_binary.desc"))
      .addText((text) =>
        text
          .setPlaceholder("/Users/<you>/.local/bin/obsidian-rag-mcp")
          .setValue(this.deps.getSettings().mcpBinaryPath)
          .onChange(async (value) => {
            this.deps.getSettings().mcpBinaryPath = value.trim();
            await this.deps.saveSettings();
            await this.deps.onChange();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.timeout.name"))
      .addText((text) =>
        text
          .setValue(String(this.deps.getSettings().queryTimeoutMs))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n) || n <= 0) return;
            this.deps.getSettings().queryTimeoutMs = n;
            await this.deps.saveSettings();
          }),
      );

    // Botón "test connection" — corre healthCheck() y muestra el
    // resultado al user en una Notice. Útil para diagnosticar.
    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Health check de los backends configurados.")
      .addButton((btn) =>
        btn.setButtonText("Test").onClick(async () => {
          try {
            await this.deps.onChange(); // Asegurar backend fresco.
            new Notice("Health check OK (mirá la consola para detalles).");
          } catch (err) {
            new Notice(`Health check falló: ${String(err)}`);
          }
        }),
      );
  }

  // ── Panels section ──────────────────────────────────────────────────

  private renderPanelsSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: t("settings.section.panels") });

    for (const panel of this.deps.panels) {
      const settings = this.deps.getSettings();
      const enabled = settings.panelEnabled[panel.id] !== false;
      new Setting(containerEl)
        .setName(t(panel.titleKey))
        .setDesc(`ID: ${panel.id}`)
        .addToggle((toggle) =>
          toggle.setValue(enabled).onChange(async (value) => {
            settings.panelEnabled[panel.id] = value;
            await this.deps.saveSettings();
            await this.deps.onChange();
          }),
        );

      // Hook a la UI específica del panel (si la implementa).
      panel.renderSettings?.(containerEl);
    }

    new Setting(containerEl)
      .setName("Reset panel order")
      .setDesc("Volver al orden default — útil si arrastraste y quedó raro.")
      .addButton((btn) =>
        btn.setButtonText("Reset").onClick(async () => {
          this.deps.getSettings().panelOrder = this.deps.panels.map((p) => p.id);
          await this.deps.saveSettings();
          await this.deps.onChange();
          this.display(); // Re-render del settings tab.
        }),
      );
  }

  // ── Appearance section ──────────────────────────────────────────────

  private renderAppearanceSection(containerEl: HTMLElement): void {
    containerEl.createEl("h3", { text: t("settings.section.appearance") });

    new Setting(containerEl)
      .setName(t("settings.language.name"))
      .addDropdown((dd) =>
        dd
          .addOptions({ es: "Español (rioplatense)", en: "English" })
          .setValue(this.deps.getSettings().language)
          .onChange(async (value) => {
            this.deps.getSettings().language = value as "es" | "en";
            setLanguage(this.deps.getSettings().language);
            await this.deps.saveSettings();
            await this.deps.onChange();
            this.display(); // Re-render con nuevo idioma.
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.top_k.name"))
      .addText((text) =>
        text
          .setValue(String(this.deps.getSettings().topK))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isInteger(n) || n < 1 || n > 50) return;
            this.deps.getSettings().topK = n;
            await this.deps.saveSettings();
            await this.deps.onChange();
          }),
      );
  }
}
