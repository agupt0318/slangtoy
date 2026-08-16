// Recursive-descent parser for the Slang subset.
//
// The rule that matters: when this parser meets something it does not model, it
// throws Unsupported rather than guessing. A wrong parse would emit WGSL that
// still compiles and draws the wrong picture, which is worse than falling back
// to the official compiler.

import { lex, LexError, type Tok } from './lexer';
import type { BufferDecl, Decl, Expr, FuncDecl, GlobalConst, Module, Param, Stmt, StructDecl, TypeRef } from './ast';

export class Unsupported extends Error {
  constructor(message: string, readonly pos: number) {
    super(message);
  }
}

const TYPE_NAMES = new Set([
  'void', 'bool', 'int', 'uint', 'float',
  'float2', 'float3', 'float4', 'int2', 'int3', 'int4',
  'uint2', 'uint3', 'uint4', 'bool2', 'bool3', 'bool4',
  'float2x2', 'float3x3', 'float4x4',
]);

// Slang features that are real but out of scope. Naming them gives a better
// message than "unexpected token" and documents the boundary.
const KNOWN_UNSUPPORTED = new Set([
  'interface', 'extension', 'generic', 'typedef', 'import', '__generic',
  'RWStructuredBuffer', 'StructuredBuffer', 'Texture2D', 'SamplerState',
  'RWTexture2D', 'groupshared', 'cbuffer', 'namespace', 'enum', 'class',
]);

const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=', '>>=']);

// Tightest binding last consulted; index 0 binds loosest.
const BIN_PRECEDENCE: string[][] = [
  ['||'], ['&&'], ['|'], ['^'], ['&'],
  ['==', '!='], ['<', '>', '<=', '>='], ['<<', '>>'],
  ['+', '-'], ['*', '/', '%'],
];

export class Parser {
  private toks: Tok[];
  private i = 0;
  private structNames = new Set<string>();

  constructor(src: string) {
    try {
      this.toks = lex(src);
    } catch (e) {
      if (e instanceof LexError) throw new Unsupported(e.message, e.pos);
      throw e;
    }
  }

  private peek(offset = 0): Tok { return this.toks[Math.min(this.i + offset, this.toks.length - 1)]; }
  private at(text: string): boolean { return this.peek().text === text && this.peek().kind !== 'string'; }
  private next(): Tok { return this.toks[this.i++]; }

  private eat(text: string): boolean {
    if (this.at(text)) { this.i++; return true; }
    return false;
  }

  private expect(text: string): Tok {
    if (!this.at(text)) {
      throw new Unsupported(`expected ${JSON.stringify(text)}, found ${JSON.stringify(this.peek().text || 'end of file')}`, this.peek().pos);
    }
    return this.next();
  }

  private expectIdent(what: string): Tok {
    const t = this.peek();
    if (t.kind !== 'ident') throw new Unsupported(`expected ${what}`, t.pos);
    return this.next();
  }

  private isTypeName(text: string): boolean {
    return TYPE_NAMES.has(text) || this.structNames.has(text);
  }

  parseModule(): Module {
    const decls: Decl[] = [];
    while (this.peek().kind !== 'eof') decls.push(this.parseDecl());
    return { decls };
  }

  private parseDecl(): Decl {
    const t = this.peek();
    if (KNOWN_UNSUPPORTED.has(t.text)) {
      throw new Unsupported(`'${t.text}' is outside the fast-path subset`, t.pos);
    }
    if (this.at('struct')) return this.parseStruct();
    if (this.at('ConstantBuffer')) return this.parseBuffer();

    let stage: string | null = null;
    if (this.at('[')) stage = this.parseAttribute();

    // 'static const float X = ...' at module scope
    const isStatic = this.eat('static');
    const isConst = this.eat('const');
    if (isStatic || isConst) return this.parseGlobalConst(t.pos);

    return this.parseFunc(stage);
  }

  // [shader("fragment")] and friends. Other attributes are refused rather than
  // dropped, since silently ignoring one can change what the shader means.
  private parseAttribute(): string | null {
    const open = this.expect('[');
    const name = this.expectIdent('attribute name').text;
    let value: string | null = null;
    if (this.eat('(')) {
      const arg = this.peek();
      if (arg.kind !== 'string') throw new Unsupported('only string attribute arguments are supported', arg.pos);
      value = this.next().text;
      this.expect(')');
    }
    this.expect(']');
    if (name !== 'shader') throw new Unsupported(`attribute '[${name}]' is outside the fast-path subset`, open.pos);
    return value;
  }

  private parseStruct(): StructDecl {
    const pos = this.expect('struct').pos;
    const name = this.expectIdent('struct name').text;
    this.expect('{');
    const fields: StructDecl['fields'] = [];
    while (!this.at('}')) {
      const type = this.parseType();
      const fieldName = this.expectIdent('field name');
      if (this.at(':')) throw new Unsupported('semantics on struct fields are outside the fast-path subset', fieldName.pos);
      if (this.at('[')) throw new Unsupported('array fields are outside the fast-path subset', fieldName.pos);
      this.expect(';');
      fields.push({ type, name: fieldName.text, pos: fieldName.pos });
    }
    this.expect('}');
    this.expect(';');
    this.structNames.add(name);
    return { k: 'struct', name, fields, pos };
  }

  private parseBuffer(): BufferDecl {
    const pos = this.expect('ConstantBuffer').pos;
    this.expect('<');
    const typeName = this.expectIdent('buffer element type').text;
    this.expect('>');
    const name = this.expectIdent('buffer name').text;
    this.expect(';');
    return { k: 'buffer', typeName, name, pos };
  }

  private parseGlobalConst(pos: number): GlobalConst {
    const type = this.parseType();
    const name = this.expectIdent('constant name').text;
    this.expect('=');
    const init = this.parseExpr();
    this.expect(';');
    return { k: 'const', type, name, init, pos };
  }

  private parseFunc(stage: string | null): FuncDecl {
    const ret = this.parseType();
    const nameTok = this.expectIdent('function name');
    this.expect('(');
    const params: Param[] = [];
    while (!this.at(')')) {
      if (this.at('inout') || this.at('out') || this.at('in')) {
        throw new Unsupported(`parameter direction '${this.peek().text}' is outside the fast-path subset`, this.peek().pos);
      }
      const type = this.parseType();
      const pname = this.expectIdent('parameter name');
      let semantic: string | null = null;
      if (this.eat(':')) semantic = this.expectIdent('semantic').text;
      params.push({ type, name: pname.text, semantic, pos: pname.pos });
      if (!this.eat(',')) break;
    }
    this.expect(')');
    let semantic: string | null = null;
    if (this.eat(':')) semantic = this.expectIdent('return semantic').text;
    const body = this.parseBlock().body;
    return { k: 'func', name: nameTok.text, ret, params, semantic, stage, body, pos: nameTok.pos };
  }

  private parseType(): TypeRef {
    const t = this.peek();
    if (t.kind !== 'ident' || !this.isTypeName(t.text)) {
      throw new Unsupported(`unknown type ${JSON.stringify(t.text)}`, t.pos);
    }
    this.next();
    if (this.at('<')) throw new Unsupported('generic types are outside the fast-path subset', t.pos);
    return { name: t.text, pos: t.pos };
  }

  private parseBlock(): { k: 'block'; body: Stmt[]; pos: number } {
    const pos = this.expect('{').pos;
    const body: Stmt[] = [];
    while (!this.at('}')) {
      if (this.peek().kind === 'eof') throw new Unsupported('unterminated block', pos);
      body.push(this.parseStmt());
    }
    this.expect('}');
    return { k: 'block', body, pos };
  }

  private parseStmt(): Stmt {
    const t = this.peek();
    if (this.at('{')) return this.parseBlock();
    if (this.at('if')) return this.parseIf();
    if (this.at('for')) return this.parseFor();
    if (this.at('while')) return this.parseWhile();
    if (this.at('return')) {
      this.next();
      const value = this.at(';') ? null : this.parseExpr();
      this.expect(';');
      return { k: 'return', value, pos: t.pos };
    }
    if (this.at('break')) { this.next(); this.expect(';'); return { k: 'break', pos: t.pos }; }
    if (this.at('continue')) { this.next(); this.expect(';'); return { k: 'continue', pos: t.pos }; }
    if (this.at('discard')) { this.next(); this.expect(';'); return { k: 'discard', pos: t.pos }; }
    if (this.at('switch') || this.at('do')) {
      throw new Unsupported(`'${t.text}' is outside the fast-path subset`, t.pos);
    }

    const varStmt = this.tryParseVarDecl();
    if (varStmt) return varStmt;

    const expr = this.parseExpr();
    this.expect(';');
    return { k: 'expr', expr, pos: t.pos };
  }

  // A declaration starts with a type name followed by an identifier. Anything
  // else at statement position is an expression ('uv.y = ...' and so on).
  private tryParseVarDecl(): Stmt | null {
    const start = this.i;
    const isConst = this.at('const') || (this.at('static') && this.peek(1).text === 'const');
    if (isConst) { this.eat('static'); this.eat('const'); }

    if (this.peek().kind !== 'ident' || !this.isTypeName(this.peek().text) || this.peek(1).kind !== 'ident') {
      this.i = start;
      return null;
    }
    const type = this.parseType();
    const name = this.expectIdent('variable name');
    if (this.at('[')) throw new Unsupported('array declarations are outside the fast-path subset', name.pos);
    let init: Expr | null = null;
    if (this.eat('=')) init = this.parseExpr();
    if (this.at(',')) throw new Unsupported('multiple declarators in one statement are outside the fast-path subset', name.pos);
    this.expect(';');
    return { k: 'var', type, name: name.text, init, isConst, pos: name.pos };
  }

  private parseIf(): Stmt {
    const pos = this.expect('if').pos;
    this.expect('(');
    const cond = this.parseExpr();
    this.expect(')');
    const then = this.parseStmt();
    const els = this.eat('else') ? this.parseStmt() : null;
    return { k: 'if', cond, then, else: els, pos };
  }

  private parseFor(): Stmt {
    const pos = this.expect('for').pos;
    this.expect('(');
    let init: Stmt | null = null;
    if (!this.at(';')) {
      init = this.tryParseVarDecl();
      if (!init) {
        const e = this.parseExpr();
        this.expect(';');
        init = { k: 'expr', expr: e, pos };
      }
    } else {
      this.expect(';');
    }
    const cond = this.at(';') ? null : this.parseExpr();
    this.expect(';');
    const step = this.at(')') ? null : this.parseExpr();
    this.expect(')');
    const body = this.parseStmt();
    return { k: 'for', init, cond, step, body, pos };
  }

  private parseWhile(): Stmt {
    const pos = this.expect('while').pos;
    this.expect('(');
    const cond = this.parseExpr();
    this.expect(')');
    return { k: 'while', cond, body: this.parseStmt(), pos };
  }

  parseExpr(): Expr {
    return this.parseAssign();
  }

  private parseAssign(): Expr {
    const left = this.parseTernary();
    const t = this.peek();
    if (t.kind === 'punct' && ASSIGN_OPS.has(t.text)) {
      this.next();
      const value = this.parseAssign();
      return { k: 'assign', op: t.text, target: left, value, pos: t.pos };
    }
    return left;
  }

  private parseTernary(): Expr {
    const cond = this.parseBinary(0);
    if (!this.at('?')) return cond;
    const pos = this.expect('?').pos;
    const then = this.parseAssign();
    this.expect(':');
    const els = this.parseAssign();
    return { k: 'ternary', cond, then, else: els, pos };
  }

  private parseBinary(level: number): Expr {
    if (level >= BIN_PRECEDENCE.length) return this.parseUnary();
    let left = this.parseBinary(level + 1);
    for (;;) {
      const t = this.peek();
      if (t.kind !== 'punct' || !BIN_PRECEDENCE[level].includes(t.text)) return left;
      this.next();
      const right = this.parseBinary(level + 1);
      left = { k: 'binary', op: t.text, left, right, pos: t.pos };
    }
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === 'punct' && (t.text === '-' || t.text === '+' || t.text === '!' || t.text === '~')) {
      this.next();
      return { k: 'unary', op: t.text, operand: this.parseUnary(), pos: t.pos };
    }
    if (t.kind === 'punct' && (t.text === '++' || t.text === '--')) {
      this.next();
      return { k: 'incdec', op: t.text, target: this.parseUnary(), prefix: true, pos: t.pos };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (this.eat('.')) {
        const name = this.expectIdent('member name');
        e = { k: 'member', target: e, name: name.text, pos: name.pos };
      } else if (this.eat('[')) {
        const index = this.parseExpr();
        this.expect(']');
        e = { k: 'index', target: e, index, pos: t.pos };
      } else if (t.kind === 'punct' && (t.text === '++' || t.text === '--')) {
        this.next();
        e = { k: 'incdec', op: t.text, target: e, prefix: false, pos: t.pos };
      } else {
        return e;
      }
    }
  }

  private parsePrimary(): Expr {
    const t = this.next();
    if (t.kind === 'number') return { k: 'num', text: t.text, pos: t.pos };
    if (t.text === '(' && t.kind === 'punct') {
      const e = this.parseExpr();
      this.expect(')');
      return e;
    }
    if (t.kind === 'ident') {
      if (t.text === 'true' || t.text === 'false') return { k: 'bool', value: t.text === 'true', pos: t.pos };
      if (this.at('(')) {
        this.next();
        const args: Expr[] = [];
        while (!this.at(')')) {
          args.push(this.parseExpr());
          if (!this.eat(',')) break;
        }
        this.expect(')');
        return { k: 'call', callee: t.text, args, pos: t.pos };
      }
      return { k: 'ident', name: t.text, pos: t.pos };
    }
    throw new Unsupported(`unexpected ${JSON.stringify(t.text || 'end of file')}`, t.pos);
  }
}

export function parse(src: string): Module {
  return new Parser(src).parseModule();
}
