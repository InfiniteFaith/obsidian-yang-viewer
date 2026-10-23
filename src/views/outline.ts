// 侧边栏大纲视图：树状 / 表格两种模式
import { ItemView, WorkspaceLeaf, setIcon } from "obsidian";
import { YangNode, YangDocument } from "../lib/model";
import { YangProcessor } from "./processor";
import { YangTextView, VIEW_TYPE_YANG_TEXT } from "./yangTextView";

export const VIEW_TYPE_YANG_OUTLINE = "yang-outline-view";

type ViewMode = "tree" | "table";

// 树视图中显示的节点类型
const TREE_KEYWORDS = new Set([
  "module", "submodule", "container", "list", "leaf", "leaf-list",
  "choice", "case", "uses", "grouping", "rpc", "action", "notification",
  "input", "output", "typedef", "augment", "anydata", "anyxml", "identity", "feature",
]);

export class YangOutlineView extends ItemView {
  private mode: ViewMode = "tree";
  private doc: YangDocument | null = null;
  private unsubscribe: (() => void) | null = null;
  // 展开状态按节点路径（keyword name 序列）记忆，跨重渲染保留；切换文件时清空
  private expandedPaths = new Set<string>();

  constructor(leaf: WorkspaceLeaf, private processor: YangProcessor) {
    super(leaf);
  }

  getViewType(): string {
    return VIEW_TYPE_YANG_OUTLINE;
  }

  getDisplayText(): string {
    return "YANG outline";
  }

  getIcon(): string {
    return "git-branch";
  }

  async onOpen(): Promise<void> {
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.syncToActiveFile())
    );
    this.registerEvent(
      this.app.workspace.on("file-open", () => this.syncToActiveFile())
    );
    this.unsubscribe = this.processor.onDocument((doc) => {
      this.doc = doc;
      this.render();
    });
    await this.syncToActiveFile();
  }

  async onClose(): Promise<void> {
    this.unsubscribe?.();
  }

  toggleMode(): void {
    this.mode = this.mode === "tree" ? "table" : "tree";
    this.render();
  }

  private syncToActiveFile(): void {
    const file = this.app.workspace.getActiveFile();
    if (file?.extension === "yang") {
      // 尚无缓存时清空显示，避免残留上一个文件的大纲
      this.doc = this.processor.getCached(file.path) ?? null;
    } else {
      this.doc = null;
    }
    // 展开路径跨文件无意义，同构路径还会互相污染
    this.expandedPaths.clear();
    this.render();
  }

  // 跳转到编辑器对应行并短暂高亮；uses/augment 优先跳到目标定义处
  private jumpTo(line: number, node?: YangNode): void {
    const target = node && (node.keyword === "uses" || node.keyword === "augment")
      ? this.findDefinition(node) ?? node.lineStart
      : node?.lineStart ?? line;
    const yangLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_YANG_TEXT);
    const yangView = yangLeaves[0]?.view;
    if (yangView instanceof YangTextView) {
      this.app.workspace.revealLeaf(yangLeaves[0]);
      yangView.jumpToLine(target, node?.keyword, node?.name || undefined);
      return;
    }
    // 回退：Markdown 视图的 ephemeral state
    const leaf = this.app.workspace.getMostRecentLeaf();
    const view = leaf?.view as { setEphemeralState?: (s: unknown) => void };
    view?.setEphemeralState?.({ line: target - 1 });
  }

  // uses 跳到引用的 grouping 定义处；augment 的 arg 是目标实例路径，取末段节点名匹配
  private findDefinition(node: YangNode): number | null {
    const ast = this.doc?.ast;
    if (!ast) return null;
    const search = (n: YangNode, wantKw: string, name: string): number | null => {
      for (const c of n.children) {
        if (c.keyword === wantKw && c.name === name) return c.lineStart;
        const r = search(c, wantKw, name);
        if (r !== null) return r;
      }
      return null;
    };
    if (node.keyword === "uses") {
      const name = node.name.includes(":") ? node.name.split(":").pop()! : node.name;
      return search(ast, "grouping", name);
    }
    if (node.keyword === "augment") {
      // 路径形如 /if:interfaces/interface 或 /interfaces/interface[name='x']；取最后一个节点名
      const segments = node.name.split("/").filter((s) => s && s !== "..." && !s.includes("["));
      const last = segments[segments.length - 1];
      if (!last) return null;
      const name = last.includes(":") ? last.split(":").pop()! : last;
      const structural = ["container", "list", "leaf", "leaf-list", "choice", "case", "anydata", "anyxml", "rpc", "notification", "action"];
      for (const kw of structural) {
        const hit = search(ast, kw, name);
        if (hit !== null) return hit;
      }
      return null;
    }
    return null;
  }

  render(): void {
    const content = this.contentEl;
    content.empty();
    content.addClass("yang-outline");

    // 工具栏
    const toolbar = content.createDiv("yang-outline-toolbar");
    const countEl = toolbar.createSpan("yang-outline-count");
    countEl.setText(this.doc ? `${this.doc.nodeIndex.size} nodes` : "");
    const toggleBtn = toolbar.createEl("button", { cls: "yang-outline-toggle" });
    setIcon(toggleBtn, this.mode === "tree" ? "list" : "git-branch");
    toggleBtn.onclick = () => this.toggleMode();

    if (!this.doc || !this.doc.ast) {
      const empty = content.createDiv("yang-outline-empty");
      empty.setText("打开 .yang 文件以查看大纲");
      return;
    }

    if (this.mode === "tree") {
      this.renderTree(content, this.doc);
    } else {
      this.renderTable(content, this.doc.ast);
    }

    // 错误面板
    if (this.doc.errors.length > 0) {
      this.renderErrors(content, this.doc);
    }
  }

  private renderTree(root: HTMLElement, doc: YangDocument): void {
    const ast = doc.ast!;
    const container = root.createDiv("yang-tree");
    const titleEl = container.createDiv("yang-tree-root");
    titleEl.setText(`${ast.keyword} ${ast.name}`);
    titleEl.onclick = () => this.jumpTo(ast.lineStart);
    const list = container.createEl("ul", { cls: "yang-tree-list" });
    const rootPath = `${ast.keyword} ${ast.name}`;
    for (const child of ast.children) {
      this.renderNode(list, child, rootPath);
    }
  }

  private renderNode(parent: HTMLElement, node: YangNode, path: string): void {
    if (!TREE_KEYWORDS.has(node.keyword)) {
      return;
    }
    const li = parent.createEl("li", { cls: "yang-tree-node" });
    const row = li.createDiv("yang-tree-row");
    const nodePath = this.expandedPath(path, node);

    const hasChildren = node.children.some((c) => TREE_KEYWORDS.has(c.keyword));
    const expander = row.createSpan("yang-tree-expander");
    if (hasChildren) {
      setIcon(expander, "chevron-right");
      expander.addClass("expandable");
    } else {
      expander.addClass("empty");
      expander.setText("·");
    }

    const icon = row.createSpan("yang-tree-icon");
    setIcon(icon, iconFor(node.keyword));

    const label = row.createSpan("yang-tree-label");
    label.setText(node.keyword === "uses" ? `uses ${node.name}` : node.name || node.keyword);
    row.onclick = () => this.jumpTo(node.lineStart, node);

    // 懒渲染：首次展开时才构建子节点 DOM，重渲染后按记忆恢复
    let childList: HTMLUListElement | null = null;
    let expanded = this.expandedPaths.has(nodePath);
    const buildChildren = () => {
      childList = li.createEl("ul", { cls: "yang-tree-list" });
      for (const c of node.children) {
        this.renderNode(childList, c, nodePath);
      }
    };
    if (hasChildren && expanded) {
      buildChildren();
    }

    if (hasChildren) {
      if (expanded) setIcon(expander, "chevron-down");
      expander.onclick = (e: MouseEvent) => {
        e.stopPropagation();
        expanded = !expanded;
        if (expanded) {
          this.expandedPaths.add(nodePath);
          if (!childList) buildChildren();
          else childList.removeClass("collapsed");
        } else {
          this.expandedPaths.delete(nodePath);
          childList?.addClass("collapsed");
        }
        setIcon(expander, expanded ? "chevron-down" : "chevron-right");
      };
    }
  }

  private expandedPath(parentPath: string, node: YangNode): string {
    return `${parentPath}/${node.keyword} ${node.name}`;
  }

  private renderTable(root: HTMLElement, ast: YangNode): void {
    const wrap = root.createDiv("yang-table-wrap");
    const table = wrap.createEl("table", { cls: "yang-table" });
    const head = table.createTHead().insertRow();
    for (const h of ["节点", "类型", "路径", "行号", "关键属性"]) {
      head.appendChild(document.createElement("th")).setText(h);
    }
    const body = table.createTBody();
    const flat = flatten(ast);
    for (const { node, path } of flat) {
      const row = body.insertRow();
      row.onclick = () => this.jumpTo(node.lineStart, node);
      row.insertCell().setText(node.name || node.keyword);
      row.insertCell().setText(node.keyword);
      row.insertCell().setText(path);
      row.insertCell().setText(String(node.lineStart));
      row.insertCell().setText(propsSummary(node));
    }
  }

  private renderErrors(root: HTMLElement, doc: YangDocument): void {
    const panel = root.createDiv("yang-error-panel");
    const title = panel.createDiv("yang-error-title");
    title.setText(`问题 (${doc.errors.length})`);
    for (const err of doc.errors.slice(0, 100)) {
      const item = panel.createDiv("yang-error-item");
      item.addClass(err.severity);
      item.createSpan("yang-error-line").setText(`line ${err.line}`);
      item.createSpan("yang-error-msg").setText(err.msg);
      item.onclick = () => this.jumpTo(err.line);
    }
    if (doc.errors.length > 100) {
      panel.createDiv("yang-error-more").setText(`…其余 ${doc.errors.length - 100} 条`);
    }
  }
}

// 表格行：节点 + 从根到该节点的路径（pyang 实例路径心智模型）
interface FlatRow {
  node: YangNode;
  path: string;
}

function propsSummary(n: YangNode): string {
  const parts: string[] = [];
  if (n.props["type"]) parts.push(`type=${n.props["type"]}`);
  if (n.props["key"]) parts.push(`key=${n.props["key"]}`);
  if (n.props["config"]) parts.push(`config=${n.props["config"]}`);
  if (n.props["mandatory"]) parts.push(`mandatory=${n.props["mandatory"]}`);
  if (n.props["default"]) parts.push(`default=${n.props["default"]}`);
  return parts.join(", ");
}

function iconFor(keyword: string): string {
  switch (keyword) {
    case "container": return "box";
    case "list": return "list";
    case "leaf": return "dot";
    case "leaf-list": return "list-plus";
    case "choice": return "git-fork";
    case "case": return "corner-down-right";
    case "uses": return "link";
    case "grouping": return "layers";
    case "rpc": return "play";
    case "notification": return "bell";
    case "typedef": return "type";
    case "augment": return "plus-square";
    default: return "circle";
  }
}

function flatten(ast: YangNode): FlatRow[] {
  const out: FlatRow[] = [];
  const walk = (n: YangNode, parentPath: string) => {
    // 路径取数据节点链（list/leaf 等有名字的层级），非展示层节点（uses/case 等）直接透传父路径
    const path = n.name ? `${parentPath}/${n.name}` : parentPath;
    if (TREE_KEYWORDS.has(n.keyword)) out.push({ node: n, path });
    n.children.forEach((c) => walk(c, path));
  };
  ast.children.forEach((c) => walk(c, `/${ast.name || ast.keyword}`));
  return out;
}
