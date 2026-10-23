// 隔离 yang-parser 库，输出统一 YangDocument
// yang-parser 不提供行号，因此自建扫描器获取行号
import { YangNode, YangDocument, YangError, YANG_KEYWORDS } from "./model";
import { runSemanticRules } from "./rules";
import yangParserLib from "yang-parser";

const PROP_KEYWORDS = new Set(["type", "key", "config", "mandatory", "default", "status", "units"]);

// ---------- 词法扫描器（带行号）----------

class Scanner {
  private pos = 0;
  private line = 1;
  readonly errors: YangError[] = [];

  constructor(private src: string) {}

  private peek(): string {
    return this.src[this.pos] ?? "";
  }

  private next(): string {
    const c = this.src[this.pos++];
    if (c === "\n") this.line++;
    return c;
  }

  private skipWs(): void {
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (c === "/" && this.src[this.pos + 1] === "/") {
        while (this.pos < this.src.length && this.peek() !== "\n") this.pos++;
      } else if (c === "/" && this.src[this.pos + 1] === "*") {
        this.pos += 2;
        while (this.pos < this.src.length && !(this.peek() === "*" && this.src[this.pos + 1] === "/")) this.next();
        this.pos += 2; // consume */
      } else if (/\s/.test(c)) {
        this.next();
      } else {
        break;
      }
    }
  }

  private readIdentifier(): string | null {
    const m = /^[a-zA-Z_][a-zA-Z0-9_.\-]*/.exec(this.src.slice(this.pos, this.pos + 512));
    if (!m) return null;
    this.pos += m[0].length;
    return m[0];
  }

  private readQuoted(quote: string): string | null {
    const startLine = this.line;
    this.pos++; // opening quote
    let out = "";
    while (this.pos < this.src.length) {
      const c = this.next();
      if (c === "\\" && quote === '"') {
        const e = this.next();
        out += e === "n" ? "\n" : e === "t" ? "\t" : e;
      } else if (c === quote) {
        return out;
      } else {
        out += c;
      }
    }
    this.errors.push({ line: startLine, msg: "未闭合的字符串", severity: "error" });
    return null;
  }

  private readUnquotedArg(): string {
    let out = "";
    while (this.pos < this.src.length) {
      const c = this.peek();
      if (/\s/.test(c) || c === ";" || c === "{" || c === "}" || c === "'" || c === '"') break;
      if (c === "/" && (this.src[this.pos + 1] === "/" || this.src[this.pos + 1] === "*")) break;
      out += this.next();
    }
    return out;
  }

  // 递归下降：statement = keyword [arg] (";" | "{" stmt* "}")
  parseStatements(depth: number): Stmt[] {
    const stmts: Stmt[] = [];
    while (true) {
      this.skipWs();
      if (this.pos >= this.src.length) {
        if (depth > 0) {
          this.errors.push({ line: this.line, msg: "缺少闭合的 '}'", severity: "error" });
        }
        return stmts;
      }
      if (this.peek() === "}") {
        if (depth === 0) {
          this.errors.push({ line: this.line, msg: "多余的 '}'", severity: "error" });
          this.pos++;
          continue;
        }
        return stmts; // caller consumes the brace
      }

      const lineStart = this.line;
      const kw1 = this.readIdentifier();
      if (kw1 === null) {
        const badLine = this.line;
        const bad = this.next();
        this.errors.push({ line: badLine, msg: `非法字符 '${bad}'`, severity: "error" });
        continue;
      }
      let keyword = kw1;
      if (this.peek() === ":") {
        this.pos++;
        const kw2 = this.readIdentifier();
        if (kw2 === null) {
          this.errors.push({ line: this.line, msg: "':' 后缺少标识符", severity: "error" });
          continue;
        }
        keyword = kw2;
      }

      this.skipWs();
      let arg: string | null = null;
      const c = this.peek();
      if (c === "'" || c === '"') {
        arg = this.readQuoted(c);
        this.skipWs();
      } else if (c !== ";" && c !== "{") {
        arg = this.readUnquotedArg();
        this.skipWs();
      }

      if (this.peek() === ";") {
        this.pos++;
        stmts.push({ keyword, arg, lineStart, lineEnd: this.line, children: [] });
      } else if (this.peek() === "{") {
        this.pos++;
        const children = this.parseStatements(depth + 1);
        const lineEnd = this.line;
        this.skipWs();
        if (this.peek() === "}") {
          this.pos++;
        } else {
          this.errors.push({ line: this.line, msg: `语句 '${keyword}' 缺少闭合的 '}'`, severity: "error" });
        }
        stmts.push({ keyword, arg, lineStart, lineEnd, children });
      } else {
        this.errors.push({ line: this.line, msg: `语句 '${keyword}' 后缺少 ';' 或 '{'`, severity: "error" });
        stmts.push({ keyword, arg, lineStart, lineEnd: this.line, children: [] });
        while (this.pos < this.src.length && this.peek() !== ";" && this.peek() !== "}") this.next();
        if (this.peek() === ";") this.pos++;
      }
    }
  }
}

interface Stmt {
  keyword: string;
  arg: string | null;
  lineStart: number;
  lineEnd: number;
  children: Stmt[];
}

// ---------- 语义辅助 ----------

function toYangNode(s: Stmt, nextId: { n: number }, index: Map<number, YangNode>): YangNode {
  const props: Record<string, string> = {};
  for (const c of s.children) {
    if (PROP_KEYWORDS.has(c.keyword) && c.arg !== null) {
      props[c.keyword] = c.arg;
    }
  }
  const node: YangNode = {
    id: nextId.n++,
    keyword: s.keyword,
    name: s.arg ?? "",
    lineStart: s.lineStart,
    lineEnd: s.lineEnd,
    children: s.children.map((c) => toYangNode(c, nextId, index)),
    props,
  };
  index.set(node.id, node);
  return node;
}

function isKnownKeyword(kw: string): boolean {
  return YANG_KEYWORDS.has(kw) || kw.includes(":");
}

// ---------- 对外 API ----------

export function parseYangDocument(src: string): YangDocument {
  const scanner = new Scanner(src);
  const roots = scanner.parseStatements(0);
  const errors: YangError[] = [...scanner.errors];

  let ast: YangNode | null = null;
  const nodeIndex = new Map<number, YangNode>();

  // 多个顶层语句时只取第一个 module/submodule，其余报错
  const top = roots.find((r) => r.keyword === "module" || r.keyword === "submodule");
  if (!top && roots.length > 0) {
    errors.push({ line: roots[0].lineStart, msg: "文件应从 module 或 submodule 开始", severity: "error" });
  } else if (top) {
    for (const r of roots) {
      if (r !== top && (r.keyword === "module" || r.keyword === "submodule")) {
        errors.push({ line: r.lineStart, msg: `多余的顶层 ${r.keyword} "${r.arg}"`, severity: "error" });
      }
    }
    const nextId = { n: 0 };
    ast = toYangNode(top, nextId, nodeIndex);

    const checkKw = (n: YangNode) => {
      if (!isKnownKeyword(n.keyword)) {
        errors.push({ line: n.lineStart, msg: `未知关键字 "${n.keyword}"`, severity: "error" });
      }
      n.children.forEach(checkKw);
    };
    checkKw(ast);

    errors.push(...runSemanticRules(ast));
  }

  // yang-parser 权威校验：仅自建扫描器零语法错误时运行，语义告警不抑制语法检查
  if (!scanner.errors.some((x) => x.severity === "error")) {
    errors.push(...authoritativeCheck(src));
  }

  errors.sort((a, b) => a.line - b.line);
  return { ast, errors, nodeIndex };
}

// yang-parser 权威校验：仅当自建扫描器零错误时运行（由 processor 调用），返回其报错（带 best-effort 行号）
export function authoritativeCheck(src: string): YangError[] {
  try {
    yangParserLib.parse(src);
    return [];
  } catch (e) {
    const line = extractErrorLine(e);
    const msg = e instanceof Error ? e.message : String(e);
    return [{ line, msg: `语法错误: ${msg}`, severity: "error" }];
  }
}

// 从 yang-parser 的错误消息中尽力提取行号（如 "line 3"），失败时返回 0 表示未知
function extractErrorLine(e: unknown): number {
  const msg = e instanceof Error ? e.message : String(e);
  const m = /line\s+(\d+)/i.exec(msg);
  return m ? Number(m[1]) : 0;
}
