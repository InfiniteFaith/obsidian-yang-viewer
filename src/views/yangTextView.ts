import { TextFileView, WorkspaceLeaf, TFile } from "obsidian";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import type YangViewerPlugin from "../main";
import type { YangViewerSettings } from "../main";
import { yangLanguage, yangHighlight, yangDiagnostics, yangHover, setYangErrors, yangFold, buildEditorTheme, flashRange, yangFlash } from "./editor";
import type { YangDocument } from "../lib/model";

export const VIEW_TYPE_YANG_TEXT = "yang-text-view";

export class YangTextView extends TextFileView {
  private cm: EditorView | null = null;
  private reloading = false;
  private unsubscribe: (() => void) | null = null;
  private themeCompartment = new Compartment();

  constructor(leaf: WorkspaceLeaf, private plugin: YangViewerPlugin) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_YANG_TEXT;
  }

  getViewData(): string {
    return this.cm?.state.doc.toString() ?? this.data;
  }

  setViewData(data: string, clear: boolean): void {
    this.data = data;
    if (clear || !this.cm) {
      this.mountEditor(data);
    } else if (!this.reloading) {
      this.reloading = true;
      this.cm.dispatch({
        changes: { from: 0, to: this.cm.state.doc.length, insert: data },
      });
      this.reloading = false;
    }
    this.plugin.processor.parseNow(this.file?.path ?? "", data);
  }

  clear(): void {
    this.cm?.dispatch({ changes: { from: 0, to: this.cm.state.doc.length, insert: "" } });
  }

  onUnload(): void {
    this.teardownEditor();
  }

  private teardownEditor(): void {
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.cm?.destroy();
    this.cm = null;
    // 清掉残留的旧编辑器 DOM 与状态类，防止重复滚动条
    this.contentEl.removeClass("cm-yang");
    this.contentEl.querySelectorAll(".cm-editor").forEach((el) => el.remove());
  }

  getDisplayText(): string {
    return this.file?.basename ?? "YANG";
  }

  canAcceptExtension(extension: string): boolean {
    return extension === "yang";
  }

  private mountEditor(initial: string): void {
    // 同一 leaf 内切换文件时会再次挂载：先销毁旧编辑器，避免多个滚动条/多实例
    this.teardownEditor();

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged && !this.reloading) {
        this.data = update.state.doc.toString();
        const path = this.file?.path;
        if (path) {
          this.plugin.processor.scheduleParse(path, this.data);
        }
      }
    });

    const errorsGetter = (): YangDocument["errors"] => {
      const path = this.file?.path;
      return path ? this.plugin.processor.getCached(path)?.errors ?? [] : [];
    };

    this.cm = new EditorView({
      state: EditorState.create({
        doc: initial,
        extensions: [
          yangLanguage,
          yangHighlight,
          yangFold,
          yangFlash,
          history(),
          lineNumbers(),
          highlightActiveLine(),
          // 诊断装饰 + hover：解析 effect 派发前挂载，波浪线才会渲染
          yangDiagnostics(errorsGetter),
          yangHover(errorsGetter),
          this.themeCompartment.of(buildEditorTheme(this.plugin.settings)),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          updateListener,
        ],
      }),
      parent: this.contentEl,
    });
    this.contentEl.addClass("cm-yang");

    // 解析完成后：更新诊断装饰 + 触发大纲刷新
    this.unsubscribe = this.plugin.processor.onDocument((doc: YangDocument) => {
      if (this.cm && this.file && doc === this.plugin.processor.getCached(this.file.path)) {
        this.cm.dispatch({ effects: setYangErrors.of(doc.errors) });
      }
    });
  }

  // 设置变更时热更新字体/字号
  applySettings(settings: YangViewerSettings): void {
    this.cm?.dispatch({
      effects: this.themeCompartment.reconfigure(buildEditorTheme(settings)),
    });
  }

  // 跳转支持：大纲点击行号时调用——定位到该行的关键字/参数字段并闪烁高亮
  jumpToLine(line: number, keyword?: string, arg?: string): void {
    if (!this.cm) return;
    const doc = this.cm.state.doc;
    const target = Math.max(1, Math.min(line, doc.lines));
    const lineInfo = doc.line(target);
    const lineText = doc.sliceString(lineInfo.from, lineInfo.to);

    // 在行内定位 arg（优先）或 keyword 的字符范围，跳转高亮落在字段本身
    let range: { from: number; to: number } | null = null;
    if (arg) {
      const idx = lineText.indexOf(arg);
      if (idx >= 0) {
        range = { from: lineInfo.from + idx, to: lineInfo.from + idx + arg.length };
      }
    }
    if (!range && keyword) {
      const idx = lineText.indexOf(keyword);
      if (idx >= 0) {
        range = { from: lineInfo.from + idx, to: lineInfo.from + idx + keyword.length };
      }
    }
    const anchor = range ? range.from : Math.min(lineInfo.from, doc.length);

    this.cm.dispatch({
      selection: { anchor },
      scrollIntoView: true,
      effects: EditorView.scrollIntoView(anchor, { y: "center" }),
    });
    flashRange(this.cm, range ?? { from: lineInfo.from, to: lineInfo.to > lineInfo.from ? lineInfo.to : lineInfo.from + 1 });
    this.cm.focus();
  }
}
