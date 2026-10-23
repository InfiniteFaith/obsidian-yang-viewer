// 统一节点与文档模型
export interface YangNode {
  id: number;           // 文档内唯一，按出现顺序递增
  keyword: string;      // e.g. "container", "list", "leaf"
  name: string;         // e.g. "interfaces", 空字符串表示无参数
  lineStart: number;    // 1-based
  lineEnd: number;
  children: YangNode[];
  props: Record<string, string>; // 抽取的关键属性: type/key/config/mandatory/default
}

export type YangSeverity = "error" | "warning";

export interface YangError {
  line: number;
  msg: string;
  severity: YangSeverity;
}

export interface YangDocument {
  ast: YangNode | null;   // 顶层 module/submodule 节点
  errors: YangError[];
  nodeIndex: Map<number, YangNode>; // id → 节点
}

export const BUILTIN_TYPES = new Set([
  "binary", "bits", "boolean", "decimal64", "empty", "enumeration",
  "identityref", "instance-identifier", "int8", "int16", "int32", "int64",
  "leafref", "string", "uint8", "uint16", "uint32", "uint64", "union",
]);

// 解析器可识别的全部 YANG 1.0/1.1 关键字
export const YANG_KEYWORDS = new Set([
  "action", "anydata", "anyxml", "argument", "augment", "base",
  "belongs-to", "bit", "case", "choice", "config", "contact", "container",
  "default", "description", "deviate", "deviation", "enum", "error-app-tag",
  "error-message", "extension", "feature", "fraction-digits", "grouping",
  "identity", "if-feature", "import", "include", "input", "key", "leaf",
  "leaf-list", "length", "list", "mandatory", "max-elements", "min-elements",
  "modifier", "module", "must", "namespace", "notification", "ordered-by",
  "organization", "output", "path", "pattern", "position", "presence",
  "prefix",
  "range", "reference", "refine", "require-instance", "revision",
  "revision-date", "rpc", "status", "submodule", "type", "typedef", "unique",
  "units", "uses", "value", "when", "yang-version", "yin-element",
]);
