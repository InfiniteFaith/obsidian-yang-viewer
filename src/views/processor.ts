// 解析调度器：防抖 + 缓存 + 通知视图刷新
// 语义规则与权威校验在 parserAdapter.parseYangDocument 内完成
import { debounce, Debouncer } from "obsidian";
import { parseYangDocument } from "../lib/parserAdapter";
import { YangDocument } from "../lib/model";

type DocumentListener = (doc: YangDocument) => void;

const CACHE_LIMIT = 20;

export class YangProcessor {
  private cache = new Map<string, YangDocument>();
  private listeners = new Set<DocumentListener>();
  private currentPath: string | null = null;
  private parseSeq = 0; // 竞态防护：parseNow 的 token，仅最新者可写 currentPath
  private debouncedParse: Debouncer<[string, string, number], void>;

  constructor() {
    this.debouncedParse = debounce(
      (path: string, content: string, seq: number) => {
        const doc = this.doParse(content);
        // 仅当期间没有打开其他文件时才写入/通知，避免过期解析覆盖最新条目
        if (this.currentPath === path && this.parseSeq === seq) {
          this.cache.set(path, doc);
          this.evictCache();
          this.notify(doc);
        }
      },
      500,
      true
    );
  }

  // 立即解析（打开文件时）
  parseNow(path: string, content: string): YangDocument {
    const seq = ++this.parseSeq;
    const doc = this.doParse(content);
    this.cache.set(path, doc);
    this.currentPath = path;
    this.notify(doc);
    return doc;
  }

  // 编辑时防抖解析
  scheduleParse(path: string, content: string): void {
    this.currentPath = path;
    this.debouncedParse(path, content, this.parseSeq);
  }

  getCached(path: string): YangDocument | undefined {
    return this.cache.get(path);
  }

  onDocument(listener: DocumentListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private doParse(content: string): YangDocument {
    try {
      return parseYangDocument(content);
    } catch (e) {
      // 双保险：适配层不应抛出，但兜底保证编辑器不受影响
      console.error("YANG parse crashed:", e);
      return { ast: null, errors: [{ line: 1, msg: "解析失败", severity: "error" }], nodeIndex: new Map() };
    }
  }

  private evictCache(): void {
    while (this.cache.size > CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }

  private notify(doc: YangDocument): void {
    this.listeners.forEach((l) => l(doc));
  }
}
