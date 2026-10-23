// 解析适配层单元测试
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { parseYangDocument } from "../src/lib/parserAdapter";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "fixtures", name), "utf-8");

describe("parseYangDocument - valid module", () => {
  const doc = parseYangDocument(fixture("valid-module.yang"));

  it("解析出顶层 module 节点", () => {
    expect(doc.ast).not.toBeNull();
    expect(doc.ast!.keyword).toBe("module");
    expect(doc.ast!.name).toBe("demo-interfaces");
  });

  it("无错误", () => {
    expect(doc.errors).toEqual([]);
  });

  it("节点数量合理", () => {
    expect(doc.nodeIndex.size).toBeGreaterThan(10);
  });

  it("层级结构正确：interfaces 下有 list interface", () => {
    const interfaces = doc.ast!.children.find((c) => c.name === "interfaces");
    expect(interfaces?.keyword).toBe("container");
    const iface = interfaces?.children.find((c) => c.name === "interface");
    expect(iface?.keyword).toBe("list");
    expect(iface?.props["key"]).toBe("name");
  });

  it("行号定位准确：module 起始于第 1 行", () => {
    expect(doc.ast!.lineStart).toBe(1);
  });

  it("leaf 的 type 属性被抽取", () => {
    const interfaces = doc.ast!.children.find((c) => c.name === "interfaces");
    const iface = interfaces?.children.find((c) => c.name === "interface");
    const name = iface?.children.find((c) => c.keyword === "leaf" && c.name === "name");
    expect(name?.props["type"]).toBe("string");
  });
});

describe("parseYangDocument - choice/case 嵌套", () => {
  const doc = parseYangDocument(fixture("choice-cases.yang"));

  it("choice 与 case 层级正确", () => {
    const session = doc.ast!.children.find((c) => c.name === "session")!;
    const choice = session.children.find((c) => c.keyword === "choice")!;
    const cases = choice.children.filter((c) => c.keyword === "case");
    expect(cases.length).toBe(2);
  });

  it("uses 节点不展开，保留为占位", () => {
    const session = doc.ast!.children.find((c) => c.name === "session")!;
    const uses = session.children.find((c) => c.keyword === "uses");
    expect(uses?.name).toBe("endpoint");
  });

  it("rpc/notification 被识别", () => {
    const notif = doc.ast!.children.find((c) => c.keyword === "notification");
    expect(notif?.name).toBe("link-down");
  });
});

describe("parseYangDocument - 语义错误", () => {
  const doc = parseYangDocument(fixture("semantic-errors.yang"));

  it("报出 yang-version 错误", () => {
    expect(doc.errors.some((e) => e.msg.includes("yang-version"))).toBe(true);
  });

  it("报出 key 引用错误", () => {
    expect(doc.errors.some((e) => e.msg.includes("missing-key"))).toBe(true);
  });

  it("报出 mandatory+default 冲突告警", () => {
    expect(doc.errors.some((e) => e.severity === "warning" && e.msg.includes("mandatory"))).toBe(true);
  });

  it("报出未知类型", () => {
    expect(doc.errors.some((e) => e.msg.includes("my-unknown-type"))).toBe(true);
  });

  it("报出 typedef 重名", () => {
    expect(doc.errors.filter((e) => e.msg.includes("重名")).length).toBe(1);
  });
});

describe("parseYangDocument - 语法错误", () => {
  it("未闭合花括号被捕获", () => {
    const doc = parseYangDocument(fixture("syntax-error.yang"));
    expect(doc.errors.length).toBeGreaterThan(0);
    expect(doc.errors.some((e) => e.severity === "error")).toBe(true);
  });

  it("错误按行号排序", () => {
    const doc = parseYangDocument(fixture("syntax-error.yang"));
    const lines = doc.errors.map((e) => e.line);
    expect(lines).toEqual([...lines].sort((a, b) => a - b));
  });
});

describe("parseYangDocument - 1.1 版本特性", () => {
  const doc = parseYangDocument(fixture("yang11-module.yang"));

  it("解析出顶层 module", () => {
    expect(doc.ast).not.toBeNull();
    expect(doc.ast!.keyword).toBe("module");
    expect(doc.ast!.name).toBe("yang-11-demo");
  });

  it("1.1 特性 anydata/anyxml/identity 被识别且无错误", () => {
    expect(doc.errors).toEqual([]);
    expect(doc.ast!.children.some((c) => c.keyword === "anydata")).toBe(true);
    expect(doc.ast!.children.some((c) => c.keyword === "anyxml")).toBe(true);
    expect(doc.ast!.children.filter((c) => c.keyword === "identity").length).toBe(2);
  });

  it("augment 节点保留为占位", () => {
    const aug = doc.ast!.children.find((c) => c.keyword === "augment");
    expect(aug?.name).toBe("/server");
  });

  it("节点索引覆盖全部节点", () => {
    expect(doc.nodeIndex.size).toBeGreaterThan(15);
  });
});

describe("parseYangDocument - 空文档与边界", () => {
  it("空字符串返回 null ast", () => {
    const doc = parseYangDocument("");
    expect(doc.ast).toBeNull();
    expect(doc.nodeIndex.size).toBe(0);
  });

  it("注释不影响解析", () => {
    const src = `// 行注释\nmodule m { /* 块\n注释 */ namespace "urn:t"; prefix p; }`;
    const doc = parseYangDocument(src);
    expect(doc.errors).toEqual([]);
    expect(doc.ast?.name).toBe("m");
  });
});
