// 插件入口
import { Plugin, WorkspaceLeaf, TFile, TAbstractFile, Menu, PluginSettingTab, App, Setting, DropdownComponent } from "obsidian";
import { YangProcessor } from "./views/processor";
import { YangOutlineView, VIEW_TYPE_YANG_OUTLINE } from "./views/outline";
import { YangTextView, VIEW_TYPE_YANG_TEXT } from "./views/yangTextView";

export interface YangViewerSettings {
  fontFamily: string;
  fontSize: number;
}

const DEFAULT_SETTINGS: YangViewerSettings = {
  fontFamily: "monospace",
  fontSize: 14,
};

export default class YangViewerPlugin extends Plugin {
  processor!: YangProcessor;
  settings!: YangViewerSettings;

  async onload(): Promise<void> {
    this.processor = new YangProcessor();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());

    // .yang 文件在文件列表可见，并用自定义 TextFileView 打开
    this.registerExtensions(["yang"], VIEW_TYPE_YANG_TEXT);
    this.registerView(VIEW_TYPE_YANG_TEXT, (leaf: WorkspaceLeaf) => new YangTextView(leaf, this));

    this.registerView(VIEW_TYPE_YANG_OUTLINE, (leaf: WorkspaceLeaf) => new YangOutlineView(leaf, this.processor));

    this.addSettingTab(new YangSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.parseActiveFile())
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.parseActiveFile())
    );

    this.addCommand({
      id: "show-yang-outline",
      name: "Show YANG outline",
      callback: () => void this.activateOutline(),
    });

    this.addCommand({
      id: "switch-yang-view-mode",
      name: "Switch to table view",
      callback: () => {
        const view = this.getOutlineLeaf()?.view;
        if (view instanceof YangOutlineView) view.toggleMode();
      },
    });

    // 文件列表右键菜单：.yang 文件显示 Show YANG outline
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu: Menu, file: TAbstractFile) => {
        if (file instanceof TFile && file.extension === "yang") {
          this.addOutlineMenuItem(menu, () => {
            void this.app.workspace.getLeaf("tab").openFile(file);
            void this.activateOutline();
          });
        }
      })
    );

    // 编辑器内右键菜单：当前文件是 .yang 时显示
    this.registerEvent(
      this.app.workspace.on("editor-menu", (menu: Menu, _editor, info) => {
        if (info.file?.extension === "yang") {
          this.addOutlineMenuItem(menu, () => void this.activateOutline());
        }
      })
    );

    this.app.workspace.onLayoutReady(() => this.parseActiveFile());
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_YANG_TEXT);
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_YANG_OUTLINE);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  applyEditorSettings(): void {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_YANG_TEXT)) {
      const view = leaf.view;
      if (view instanceof YangTextView) view.applySettings(this.settings);
    }
  }

  private parseActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== "yang") return;
    // YangTextView 打开时由 setViewData 负责解析；这里兜底处理其他路径
    if (this.app.workspace.activeEditor?.file?.extension === "yang") return;
    void this.app.vault.cachedRead(file).then((content) => {
      // 竞态防护：异步期间活动文件可能已切换，避免用过期内容覆盖
      if (this.app.workspace.getActiveFile() !== file) return;
      this.processor.parseNow(file.path, content);
    });
  }

  private addOutlineMenuItem(menu: Menu, onClick: () => void): void {
    menu.addItem((item) => {
      item.setTitle("Show YANG outline").setIcon("git-branch").onClick(onClick);
    });
  }

  private getOutlineLeaf(): WorkspaceLeaf | null {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_YANG_OUTLINE);
    return leaves[0] ?? null;
  }

  async activateOutline(): Promise<void> {
    const existing = this.getOutlineLeaf();
    if (existing) {
      this.app.workspace.revealLeaf(existing);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    await leaf?.setViewState({ type: VIEW_TYPE_YANG_OUTLINE, active: true });
    if (leaf) this.app.workspace.revealLeaf(leaf);
  }
}

const FALLBACK_FONTS = ["Consolas", "Courier New", "JetBrains Mono", "Cascadia Code", "Source Code Pro", "Menlo", "Arial"];

// Electron 支持 Local Font Access API 枚举系统字体；不可用时退回常见等宽字体
function getSystemFonts(): Promise<string[]> {
  const qlf = (globalThis as { queryLocalFonts?: () => Promise<Array<{ family: string }>> }).queryLocalFonts;
  if (typeof qlf !== "function") return Promise.resolve([]);
  return qlf()
    .then((fonts) => [...new Set(fonts.map((f) => f.family))].sort((a, b) => a.localeCompare(b)))
    .catch(() => []);
}

// 下拉框先展示的兜底字体列表（系统字体枚举完成后被替换）
function fallbackFontOptions(): string[] {
  return ["monospace", ...FALLBACK_FONTS];
}

// 系统字体枚举完成后重建下拉选项（保留当前选中值）
async function refreshFontOptions(dropdown: DropdownComponent, current: string): Promise<void> {
  const fonts = await getSystemFonts();
  if (fonts.length === 0) return;
  const el = dropdown.selectEl;
  el.empty();
  for (const f of ["monospace", ...fonts]) {
    el.createEl("option", { value: f, text: f });
  }
  if (!Array.from(el.options).some((o) => o.value === current)) {
    el.createEl("option", { value: current, text: current });
  }
  el.value = current;
}

class YangSettingTab extends PluginSettingTab {
  constructor(app: App, private plugin: YangViewerPlugin) {
    super(app, plugin);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "YANG Viewer 设置" });

    new Setting(containerEl)
      .setName("编辑器字体")
      .setDesc("YANG 编辑器使用的字体")
      .addDropdown((dropdown) => {
        const options = fallbackFontOptions();
        for (const f of options) dropdown.addOption(f, f);
        if (!options.includes(this.plugin.settings.fontFamily)) {
          dropdown.addOption(this.plugin.settings.fontFamily, this.plugin.settings.fontFamily);
        }
        dropdown.setValue(this.plugin.settings.fontFamily).onChange(async (value) => {
          this.plugin.settings.fontFamily = value;
          await this.plugin.saveSettings();
          this.plugin.applyEditorSettings();
        });
        // 异步枚举系统字体后重建下拉选项
        void refreshFontOptions(dropdown, this.plugin.settings.fontFamily);
        return dropdown;
      });

    new Setting(containerEl)
      .setName("编辑器字号")
      .setDesc("10 - 32 之间")
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.fontSize))
          .onChange(async (value) => {
            const n = Number(value);
            if (!Number.isFinite(n)) return;
            this.plugin.settings.fontSize = Math.min(32, Math.max(10, Math.round(n)));
            await this.plugin.saveSettings();
            this.plugin.applyEditorSettings();
          })
      );
  }
}
