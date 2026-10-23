// CodeMirror 6 扩展：yang 语法高亮（StreamParser 见 yangParser.ts）+ 诊断装饰
import { StreamLanguage } from "@codemirror/language";
import { HighlightStyle, syntaxHighlighting, foldService, foldGutter, codeFolding } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, hoverTooltip } from "@codemirror/view";
import { RangeSetBuilder, StateEffect, StateField, Compartment } from "@codemirror/state";
import type { Extension, EditorState } from "@codemirror/state";
import type { Text } from "@codemirror/state";
import type { YangError } from "../lib/model";
import type { YangViewerSettings } from "../main";
import { yangParser } from "./yangParser";

export const yangLanguage: Extension = StreamLanguage.define(yangParser);

// 编辑器主题（高度 + 字体/字号），由设置面板驱动
export function buildEditorTheme(settings: YangViewerSettings): Extension {
  const font = settings.fontFamily || "monospace";
  return EditorView.theme({
    "&": {
      height: "100%",
      color: "var(--text-normal)",
      backgroundColor: "var(--background-primary)",
    },
    ".cm-scroller": {
      overflow: "auto",
      fontFamily: font,
      fontSize: `${settings.fontSize}px`,
      lineHeight: "1.5",
    },
    ".cm-gutters": {
      fontFamily: font,
      fontSize: `${settings.fontSize}px`,
      // 跟随 Obsidian 主题（深/浅色自动切换）
      backgroundColor: "var(--background-primary)",
      color: "var(--text-faint)",
      border: "none",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "var(--background-primary-alt)",
      color: "var(--text-muted)",
    },
    ".cm-activeLine": {
      backgroundColor: "var(--background-primary-alt)",
    },
    ".cm-foldGutter span": {
      color: "var(--text-faint)",
    },
  });
}

// StreamLanguage 只产生 token 类名，必须挂上高亮样式才会着色
// 用 CM6 原生 HighlightStyle：样式直接注入编辑器 theme，不受 Obsidian 主题 CSS 覆盖
// 标识符不着色（跟随正文颜色）：文档大部分是标识符，避免快速滚动时白→红闪变
export const yangHighlight: Extension = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.keyword, tags.atom], color: "var(--code-keyword, #c678dd)" },
  { tag: tags.string, color: "var(--code-value, #98c379)" },
  { tag: tags.comment, color: "var(--code-comment, var(--text-faint))", fontStyle: "italic" },
  { tag: tags.variableName, color: "var(--code-normal, var(--text-normal))" },
  { tag: [tags.operator, tags.punctuation], color: "var(--code-operator, var(--text-muted))" },
]));

const errorMark = Decoration.mark({ class: "cm-yang-error" });
const warningMark = Decoration.mark({ class: "cm-yang-warning" });

export type ErrorsGetter = () => YangError[];

// 解析完成后由 processor 派发此 effect 触发装饰重画
export const setYangErrors = StateEffect.define<YangError[]>();

// 诊断插件：错误数据变化或文档变化时重画行内标记
export function yangDiagnostics(getErrors: ErrorsGetter): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;

      constructor(private view: EditorView) {}

      update(update: ViewUpdate) {
        let hasEffect = false;
        for (const tr of update.transactions) {
          for (const e of tr.effects) {
            if (e.is(setYangErrors)) hasEffect = true;
          }
        }
        if (update.docChanged || hasEffect) {
          this.decorations = buildDecorations(this.view, getErrors());
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}

function buildDecorations(view: EditorView, errors: YangError[]): DecorationSet {
  if (errors.length === 0) return Decoration.none;
  const doc = view.state.doc;
  const builder = new RangeSetBuilder<Decoration>();
  const sorted = [...errors].sort((a, b) => a.line - b.line || a.msg.localeCompare(b.msg));
  for (const err of sorted) {
    if (err.line < 1 || err.line > doc.lines) continue;
    const line = doc.line(err.line);
    const from = line.from;
    const to = line.to > line.from ? line.to : Math.min(line.from + 1, doc.length);
    if (to > from) {
      builder.add(from, to, err.severity === "error" ? errorMark : warningMark);
    }
  }
  return builder.finish();
}

// hover 显示该行诊断信息
export function yangHover(getErrors: ErrorsGetter): Extension {
  return hoverTooltip((view, pos) => {
    const line = view.state.doc.lineAt(pos);
    const errs = getErrors().filter((e) => e.line === line.number);
    if (errs.length === 0) return null;
    return {
      pos: line.from,
      create: () => {
        const dom = document.createElement("div");
        dom.addClass("cm-yang-tooltip");
        for (const e of errs.slice(0, 3)) {
          const item = dom.createDiv("cm-yang-tooltip-item");
          item.addClass(e.severity);
          item.setText(e.msg);
        }
        return { dom };
      },
    };
  });
}

// ---------- 跳行高亮闪烁 ----------

const flashMark = Decoration.mark({ class: "cm-yang-flash-mark" });
const setYangFlash = StateEffect.define<{ from: number; to: number } | null>(); // doc range to flash

const flashField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setYangFlash)) {
        if (e.value === null || e.value.to > tr.state.doc.length) {
          value = Decoration.none;
        } else {
          value = Decoration.set([flashMark.range(e.value.from, e.value.to)]);
        }
      }
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

// 高亮指定字段范围 900ms 后自动消除；整行闪烁由调用方传行范围。
// 可取消：快速连续跳行时旧定时器不清理新闪烁；视图销毁时一并清掉定时器
export function flashLine(view: EditorView, line: number): void {
  const l = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
  flashRange(view, { from: l.from, to: l.to });
}

export function flashRange(view: EditorView, range: { from: number; to: number }): void {
  view.dispatch({ effects: setYangFlash.of({ from: range.from, to: range.to }) });
  const timers = view.state.field(flashTimersField);
  if (timers.clear !== null) window.clearTimeout(timers.clear);
  timers.clear = window.setTimeout(() => {
    if (!view.dom.isConnected) return;
    view.dispatch({
      effects: [setYangFlash.of(null), flashTimers.of(null)],
    });
  }, 900);
}

// 每视图一个槽位记录当前闪烁定时器，供连续跳行时取消旧定时器
const flashTimers = StateEffect.define<null>();
const flashTimersField = StateField.define<{ clear: number | null }>({
  create: () => ({ clear: null }),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(flashTimers)) return { clear: null };
    }
    return value;
  },
});

// 视图销毁时取消闪烁定时器
export const yangFlash: Extension = [
  flashField,
  flashTimersField,
  ViewPlugin.fromClass(
    class {
      constructor(private view: EditorView) {}
      destroy() {
        const t = this.view.state.field(flashTimersField, false);
        if (t?.clear != null) window.clearTimeout(t.clear);
      }
    }
  ),
];

// 大括号折叠：从 { 起向前扫描匹配的 }，忽略注释与字符串。
// 按行迭代 Text 并维护跨行状态（块注释/字符串），避免全文 stringify
// （旧实现在每次改文档事务上都 O(doc) stringify，即使无人折叠）。
// 单次查询成本与被扫描的块大小成正比，且仅该行含 "{" 时才扫描
function findMatchingBrace(doc: Text, from: number): number {
  let depth = 0;
  let inBlockComment = false;
  let inString: string | null = null;
  let first = true;
  for (let line = doc.lineAt(from); ; line = doc.lineAt(line.to + 1)) {
    const text = doc.sliceString(first ? from : line.from, line.to);
    first = false;
    let i = 0;
    while (i < text.length) {
      const c = text[i];
      if (inBlockComment) {
        const end = text.indexOf("*/", i);
        i = end >= 0 ? end + 2 : text.length;
        if (end >= 0) inBlockComment = false;
        continue;
      }
      if (inString) {
        while (i < text.length && text[i] !== inString && text[i] !== "\n") { if (text[i] === "\\" && inString === '"') i++; i++; }
        if (text[i] === inString) { i++; inString = null; }
        else i = text.length; // 字符串延续到行尾
        continue;
      }
      if (c === "/" && text[i + 1] === "/") break; // 行注释：余下忽略
      if (c === "/" && text[i + 1] === "*") { inBlockComment = true; i += 2; continue; }
      if (c === '"' || c === "'") { inString = c; i++; continue; }
      if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return line.from + i;
      }
      i++;
    }
    if (line.to === doc.length) break;
  }
  return -1;
}

export const yangFold: Extension = [
  foldGutter(),
  codeFolding(),
  foldService.of((state: EditorState, lineStart: number) => {
    const line = state.doc.lineAt(lineStart);
    const open = state.doc.sliceString(line.from, line.to).indexOf("{");
    if (open < 0) return null;
    const close = findMatchingBrace(state.doc, line.from + open);
    if (close > line.to - 1) return { from: line.from + open + 1, to: close };
    return null;
  }),
];
