declare module "yang-parser" {
  export interface YangRawStatement {
    prf: string;
    kw: string;
    arg: string | null;
    substmts: YangRawStatement[];
  }
  export function parse(src: string): YangRawStatement;
  const _default: { parse: typeof parse };
  export default _default;
}
