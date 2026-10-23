// 语义校验规则：每条规则独立函数，输入 YangNode 输出 error 列表
import { YangNode, YangError, BUILTIN_TYPES } from "./model";

// 规则 1: list 的 key 必须是直接子节点且为 leaf
function checkListKey(node: YangNode, errors: YangError[]): void {
  if (node.keyword !== "list" || !node.props["key"]) return;
  const keys = node.props["key"].split(/\s+/).filter(Boolean);
  for (const k of keys) {
    const child = node.children.find((c) => c.name === k && c.keyword !== "key");
    if (!child) {
      errors.push({ line: node.lineStart, msg: `list "${node.name}" 的 key "${k}" 不是其子节点`, severity: "error" });
    } else if (child.keyword !== "leaf") {
      errors.push({ line: child.lineStart, msg: `key "${k}" 必须是 leaf，实际是 ${child.keyword}`, severity: "error" });
    }
  }
}

// 规则 2: type 必须是内置类型或本文件内已定义的 typedef（带前缀引用无法单文件验证，跳过）
function checkTypeRef(node: YangNode, errors: YangError[], typedefNames: Set<string>): void {
  if (node.keyword !== "type" || !node.name) return;
  if (node.name.includes(":")) return; // 前缀引用（如 inet:ipv4-address），单文件模式下跳过
  if (BUILTIN_TYPES.has(node.name)) return;
  if (typedefNames.has(node.name)) return;
  errors.push({ line: node.lineStart, msg: `未知类型 "${node.name}"`, severity: "error" });
}

// 规则 3: 同 module 内 typedef 名不重复（在 collect 阶段顺带检测，见 runSemanticRules）

// 规则 4: yang-version 只允许 "1" 或 "1.1"
function checkYangVersion(node: YangNode, errors: YangError[]): void {
  if (node.keyword !== "yang-version") return;
  if (node.name !== "1" && node.name !== "1.1") {
    errors.push({ line: node.lineStart, msg: `yang-version 必须是 "1" 或 "1.1"，实际为 "${node.name}"`, severity: "error" });
  }
}

// 规则 5: leaf 同时声明 mandatory true 和 default 时告警
function checkMandatoryDefault(node: YangNode, errors: YangError[]): void {
  if (node.keyword !== "leaf") return;
  if (node.props["mandatory"] === "true" && node.props["default"] !== undefined) {
    errors.push({
      line: node.lineStart,
      msg: `leaf "${node.name}" 同时声明 mandatory true 和 default`,
      severity: "warning",
    });
  }
}

export function runSemanticRules(ast: YangNode): YangError[] {
  const errors: YangError[] = [];
  // 先全量收集 typedef 名（用于 type 引用校验 + 重名检测），再遍历校验，避免前向引用误报
  const typedefNames = new Set<string>();
  const collect = (node: YangNode) => {
    if (node.keyword === "typedef" && node.name) {
      if (typedefNames.has(node.name)) {
        errors.push({ line: node.lineStart, msg: `typedef "${node.name}" 重名`, severity: "error" });
      }
      typedefNames.add(node.name);
    }
    node.children.forEach(collect);
  };
  collect(ast);

  const walk = (node: YangNode) => {
    checkListKey(node, errors);
    checkTypeRef(node, errors, typedefNames);
    checkMandatoryDefault(node, errors);
    checkYangVersion(node, errors);
    node.children.forEach(walk);
  };
  walk(ast);
  return errors;
}
