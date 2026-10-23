// YANG StreamParser：识别注释、字符串（含跨行）、关键字、标点
import type { StreamParser } from "@codemirror/language";
import { YANG_KEYWORDS } from "../lib/model";

// 跨行状态：字符串/块注释可能延续到下一行
interface YangStreamState {
  inString: string | null;
  inBlockComment: boolean;
}

export const yangParser: StreamParser<YangStreamState> = {
  name: "yang",
  startState(): YangStreamState {
    return { inString: null, inBlockComment: false };
  },
  copyState(s: YangStreamState): YangStreamState {
    return { inString: s.inString, inBlockComment: s.inBlockComment };
  },
  token(stream, state) {
    if (stream.eatSpace()) return null;

    if (state.inBlockComment) {
      while (!stream.eol()) {
        if (stream.match("*/")) { state.inBlockComment = false; break; }
        stream.next();
      }
      return "comment";
    }
    if (state.inString) {
      const quote = state.inString;
      while (!stream.eol()) {
        const c = stream.next();
        if (c === "\\" && quote === '"') stream.next();
        else if (c === quote) { state.inString = null; break; }
      }
      return "string";
    }

    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }
    if (stream.match("/*")) {
      while (!stream.eol()) {
        if (stream.match("*/")) return "comment";
        stream.next();
      }
      state.inBlockComment = true;
      return "comment";
    }
    if (stream.peek() === '"' || stream.peek() === "'") {
      const quote = stream.next()!;
      let closed = false;
      while (!stream.eol()) {
        const c = stream.next();
        if (c === "\\" && quote === '"') stream.next();
        else if (c === quote) { closed = true; break; }
      }
      // 到行尾仍未闭合：跨行字符串，下一行继续
      if (!closed) state.inString = quote;
      return "string";
    }
    if (stream.match(/^[a-zA-Z_][a-zA-Z0-9_.\-]*/)) {
      const word = stream.current();
      if (YANG_KEYWORDS.has(word)) return "keyword";
      if (word === "true" || word === "false") return "atom";
      return "variableName";
    }
    if (stream.match(/^[;{}]/)) return "punctuation";
    stream.next();
    return null;
  },
};
