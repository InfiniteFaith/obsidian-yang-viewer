// rules.ts 语义规则独立单元测试（规格 §5：每条规则独立验证）
import { describe, it, expect } from "vitest";
import { runSemanticRules } from "../src/lib/rules";
import type { YangNode } from "../src/lib/model";

let idSeq = 0;
function node(keyword: string, name = "", props: Record<string, string> = {}, children: YangNode[] = []): YangNode {
  return { id: idSeq++, keyword, name, lineStart: 1, lineEnd: 1, children, props };
}

describe("规则 1: list key 引用检查", () => {
  it("key 引用不存在的子节点时报错", () => {
    const list = node("list", "if", { key: "name" }, [node("leaf", "other")]);
    const errors = runSemanticRules(list);
    expect(errors.some((e) => e.msg.includes("key") && e.severity === "error")).toBe(true);
  });

  it("key 子节点不是 leaf 时报错", () => {
    const list = node("list", "l", { key: "name" }, [node("container", "name")]);
    const errors = runSemanticRules(list);
    expect(errors.some((e) => e.msg.includes("必须是 leaf"))).toBe(true);
  });

  it("合法 key 无报错", () => {
    const list = node("list", "l", { key: "name" }, [node("leaf", "name")]);
    expect(runSemanticRules(list)).toEqual([]);
  });
});

describe("规则 2: type 引用检查", () => {
  it("内置类型通过", () => {
    const n = node("type", "uint32");
    expect(runSemanticRules(node("leaf", "x", {}, [n]))).toEqual([]);
  });

  it("已定义 typedef 通过（前向引用允许）", () => {
    const typedef = node("typedef", "my-t", {}, [node("type", "string")]);
    const use = node("type", "my-t");
    const mod = node("module", "m", {}, [typedef, node("leaf", "x", {}, [use])]);
    expect(runSemanticRules(mod).filter((e) => e.msg.includes("未知类型"))).toEqual([]);
  });

  it("未知类型报错", () => {
    const use = node("type", "no-such-t");
    const errors = runSemanticRules(node("leaf", "x", {}, [use]));
    expect(errors.some((e) => e.msg.includes("未知类型"))).toBe(true);
  });

  it("带前缀引用跳过", () => {
    const use = node("type", "inet:ipv4-address");
    expect(runSemanticRules(node("leaf", "x", {}, [use])).filter((e) => e.msg.includes("未知类型"))).toEqual([]);
  });
});

describe("规则 3: typedef 重名", () => {
  it("重名报错且只报一次", () => {
    const mod = node("module", "m", {}, [
      node("typedef", "dup", {}, [node("type", "string")]),
      node("typedef", "dup", {}, [node("type", "int32")]),
    ]);
    expect(runSemanticRules(mod).filter((e) => e.msg.includes("重名")).length).toBe(1);
  });
});

describe("规则 4: yang-version 检查", () => {
  it("非法版本报错", () => {
    const errors = runSemanticRules(node("yang-version", "2.0"));
    expect(errors.some((e) => e.msg.includes("yang-version"))).toBe(true);
  });

  it("1 与 1.1 均合法", () => {
    expect(runSemanticRules(node("yang-version", "1"))).toEqual([]);
    expect(runSemanticRules(node("yang-version", "1.1"))).toEqual([]);
  });
});

describe("规则 5: mandatory + default 冲突", () => {
  it("同时声明时告警", () => {
    const leaf = node("leaf", "x", { mandatory: "true", default: "1" });
    const errors = runSemanticRules(leaf);
    expect(errors.length).toBe(1);
    expect(errors[0].severity).toBe("warning");
  });

  it("仅 mandatory 或仅 default 不告警", () => {
    expect(runSemanticRules(node("leaf", "x", { mandatory: "true" }))).toEqual([]);
    expect(runSemanticRules(node("leaf", "y", { default: "1" }))).toEqual([]);
  });
});
