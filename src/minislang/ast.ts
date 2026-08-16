// AST for the Slang subset. Deliberately small: anything not represented here
// is something the fast path refuses, so the official compiler handles it.

export interface TypeRef {
  name: string;          // 'float', 'float3', 'Uniforms', ...
  pos: number;
}

export type Expr =
  | { k: 'num'; text: string; pos: number }
  | { k: 'bool'; value: boolean; pos: number }
  | { k: 'ident'; name: string; pos: number }
  | { k: 'member'; target: Expr; name: string; pos: number }
  | { k: 'index'; target: Expr; index: Expr; pos: number }
  | { k: 'call'; callee: string; args: Expr[]; pos: number }
  | { k: 'unary'; op: string; operand: Expr; pos: number }
  | { k: 'binary'; op: string; left: Expr; right: Expr; pos: number }
  | { k: 'ternary'; cond: Expr; then: Expr; else: Expr; pos: number }
  | { k: 'assign'; op: string; target: Expr; value: Expr; pos: number }
  // ++i and i++ differ only where the value is read, and the emitter only ever
  // sees these as statements, so one node covers both.
  | { k: 'incdec'; op: string; target: Expr; prefix: boolean; pos: number };

export type Stmt =
  | { k: 'var'; type: TypeRef | null; name: string; init: Expr | null; isConst: boolean; pos: number }
  | { k: 'expr'; expr: Expr; pos: number }
  | { k: 'if'; cond: Expr; then: Stmt; else: Stmt | null; pos: number }
  | { k: 'for'; init: Stmt | null; cond: Expr | null; step: Expr | null; body: Stmt; pos: number }
  | { k: 'while'; cond: Expr; body: Stmt; pos: number }
  | { k: 'return'; value: Expr | null; pos: number }
  | { k: 'break'; pos: number }
  | { k: 'continue'; pos: number }
  | { k: 'block'; body: Stmt[]; pos: number }
  | { k: 'discard'; pos: number };

export interface Param {
  type: TypeRef;
  name: string;
  semantic: string | null;   // SV_Position and friends
  pos: number;
}

export interface FuncDecl {
  k: 'func';
  name: string;
  ret: TypeRef;
  params: Param[];
  semantic: string | null;   // return semantic, e.g. SV_Target
  stage: string | null;      // from [shader("fragment")]
  body: Stmt[];
  pos: number;
}

export interface StructDecl {
  k: 'struct';
  name: string;
  fields: { type: TypeRef; name: string; pos: number }[];
  pos: number;
}

export interface BufferDecl {
  k: 'buffer';
  typeName: string;          // the T in ConstantBuffer<T>
  name: string;
  pos: number;
}

export interface GlobalConst {
  k: 'const';
  type: TypeRef;
  name: string;
  init: Expr;
  pos: number;
}

export type Decl = FuncDecl | StructDecl | BufferDecl | GlobalConst;

export interface Module {
  decls: Decl[];
}
