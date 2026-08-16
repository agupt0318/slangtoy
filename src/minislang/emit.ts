// Slang subset -> WGSL.
//
// Every mapping here is one the official compiler also makes; where the two
// languages disagree in a way this emitter cannot bridge, it throws Unsupported
// so the caller falls back instead of emitting a shader that draws the wrong
// thing.

import type { Decl, Expr, FuncDecl, Module, Stmt, TypeRef } from './ast';
import { Unsupported } from './parser';

const SCALARS: Record<string, string> = { float: 'f32', int: 'i32', uint: 'u32', bool: 'bool', void: 'void' };
const VEC_BASE: Record<string, string> = { float: 'f32', int: 'i32', uint: 'u32', bool: 'bool' };

// Slang/HLSL builtins whose WGSL spelling differs. Anything not here and not
// user-defined is refused rather than passed through on the hope it matches.
const RENAMED: Record<string, string> = {
  frac: 'fract',
  lerp: 'mix',
  rsqrt: 'inverseSqrt',
  ddx: 'dpdx',
  ddy: 'dpdy',
  mad: 'fma',
  isnan: 'isNan',
  isinf: 'isInf',
};

const SAME_NAME = new Set([
  'abs', 'acos', 'asin', 'atan', 'atan2', 'ceil', 'clamp', 'cos', 'cosh', 'cross',
  'degrees', 'determinant', 'distance', 'dot', 'exp', 'exp2', 'faceforward', 'floor',
  'fma', 'fwidth', 'inverseSqrt', 'length', 'log', 'log2', 'max', 'min', 'mix',
  'modf', 'normalize', 'pow', 'radians', 'reflect', 'refract', 'round', 'saturate',
  'sign', 'sin', 'sinh', 'smoothstep', 'sqrt', 'step', 'tan', 'tanh', 'transpose',
  'trunc', 'countOneBits', 'reverseBits',
]);

export function typeToWgsl(t: TypeRef): string {
  if (SCALARS[t.name]) return SCALARS[t.name];
  const vec = /^(float|int|uint|bool)([234])$/.exec(t.name);
  if (vec) return `vec${vec[2]}<${VEC_BASE[vec[1]]}>`;
  const mat = /^float([234])x([234])$/.exec(t.name);
  if (mat) return `mat${mat[1]}x${mat[2]}<f32>`;
  return t.name; // a struct declared in this module
}

/** Constructor call like float3(...) -> vec3<f32>(...); null when not a type. */
function typeCtor(name: string): string | null {
  if (SCALARS[name] && name !== 'void') return SCALARS[name];
  const vec = /^(float|int|uint|bool)([234])$/.exec(name);
  if (vec) return `vec${vec[2]}<${VEC_BASE[vec[1]]}>`;
  const mat = /^float([234])x([234])$/.exec(name);
  if (mat) return `mat${mat[1]}x${mat[2]}<f32>`;
  return null;
}

const SWIZZLE = /^[xyzwrgba]{1,4}$/;

export class Emitter {
  private out: string[] = [];
  private funcNames = new Set<string>();
  private structNames = new Set<string>();
  private entry: FuncDecl | null = null;

  constructor(private mod: Module) {}

  emit(): { wgsl: string; entryName: string } {
    for (const d of this.mod.decls) {
      if (d.k === 'func') this.funcNames.add(d.name);
      if (d.k === 'struct') this.structNames.add(d.name);
    }
    for (const d of this.mod.decls) this.decl(d);
    if (!this.entry) {
      throw new Unsupported('no [shader("fragment")] entry point found', 0);
    }
    return { wgsl: this.out.join('\n'), entryName: this.entry.name };
  }

  private line(s = ''): void { this.out.push(s); }

  private decl(d: Decl): void {
    switch (d.k) {
      case 'struct': {
        this.line(`struct ${d.name} {`);
        for (const f of d.fields) this.line(`  ${f.name}: ${typeToWgsl(f.type)},`);
        this.line('};');
        this.line();
        return;
      }
      case 'buffer': {
        if (!this.structNames.has(d.typeName)) {
          throw new Unsupported(`ConstantBuffer<${d.typeName}> needs a struct declared in this file`, d.pos);
        }
        // Binding 0 of group 0 is the slot the host allocates for uniforms.
        this.line(`@group(0) @binding(0) var<uniform> ${d.name}: ${d.typeName};`);
        this.line();
        return;
      }
      case 'const': {
        this.line(`const ${d.name}: ${typeToWgsl(d.type)} = ${this.expr(d.init)};`);
        this.line();
        return;
      }
      case 'func':
        return this.func(d);
    }
  }

  private func(f: FuncDecl): void {
    const isEntry = f.stage !== null;
    if (isEntry) {
      if (f.stage !== 'fragment') {
        throw new Unsupported(`only fragment entry points are supported, found '${f.stage}'`, f.pos);
      }
      if (this.entry) throw new Unsupported('more than one fragment entry point', f.pos);
      this.entry = f;
      this.line('@fragment');
    }

    const params = f.params.map((p) => {
      const type = typeToWgsl(p.type);
      if (!isEntry) {
        if (p.semantic) throw new Unsupported('semantics are only supported on the entry point', p.pos);
        return `${p.name}: ${type}`;
      }
      const sem = (p.semantic ?? '').toLowerCase();
      if (sem === 'sv_position') return `@builtin(position) ${p.name}: ${type}`;
      throw new Unsupported(`entry parameter semantic '${p.semantic ?? 'none'}' is outside the fast-path subset`, p.pos);
    });

    let ret = '';
    if (f.ret.name !== 'void') {
      const type = typeToWgsl(f.ret);
      if (isEntry) {
        const sem = (f.semantic ?? '').toLowerCase();
        if (sem !== 'sv_target' && sem !== 'sv_target0') {
          throw new Unsupported(`entry return semantic '${f.semantic ?? 'none'}' is outside the fast-path subset`, f.pos);
        }
        ret = ` -> @location(0) ${type}`;
      } else {
        ret = ` -> ${type}`;
      }
    }

    this.line(`fn ${f.name}(${params.join(', ')})${ret} {`);
    for (const s of f.body) this.stmt(s, 1);
    this.line('}');
    this.line();
  }

  private stmt(s: Stmt, depth: number): void {
    const pad = '  '.repeat(depth);
    switch (s.k) {
      case 'var': {
        const kw = s.isConst ? 'let' : 'var';
        const type = s.type ? `: ${typeToWgsl(s.type)}` : '';
        if (!s.init) {
          if (s.isConst) throw new Unsupported('a const declaration needs an initializer', s.pos);
          this.line(`${pad}${kw} ${s.name}${type};`);
        } else {
          this.line(`${pad}${kw} ${s.name}${type} = ${this.expr(s.init)};`);
        }
        return;
      }
      case 'expr': {
        // WGSL has no prefix increment, and both forms are statements here.
        if (s.expr.k === 'incdec') {
          this.line(`${pad}${this.expr(s.expr.target)}${s.expr.op};`);
          return;
        }
        this.line(`${pad}${this.expr(s.expr)};`);
        return;
      }
      case 'if': {
        this.line(`${pad}if (${this.expr(s.cond)}) {`);
        this.stmtBody(s.then, depth + 1);
        if (s.else) {
          this.line(`${pad}} else {`);
          this.stmtBody(s.else, depth + 1);
        }
        this.line(`${pad}}`);
        return;
      }
      case 'for': {
        const init = s.init ? this.inlineStmt(s.init) : '';
        const cond = s.cond ? this.expr(s.cond) : '';
        const step = s.step ? this.inlineExpr(s.step) : '';
        this.line(`${pad}for (${init}; ${cond}; ${step}) {`);
        this.stmtBody(s.body, depth + 1);
        this.line(`${pad}}`);
        return;
      }
      case 'while': {
        this.line(`${pad}while (${this.expr(s.cond)}) {`);
        this.stmtBody(s.body, depth + 1);
        this.line(`${pad}}`);
        return;
      }
      case 'return':
        this.line(s.value ? `${pad}return ${this.expr(s.value)};` : `${pad}return;`);
        return;
      case 'break': this.line(`${pad}break;`); return;
      case 'continue': this.line(`${pad}continue;`); return;
      case 'discard': this.line(`${pad}discard;`); return;
      case 'block':
        for (const inner of s.body) this.stmt(inner, depth);
        return;
    }
  }

  private stmtBody(s: Stmt, depth: number): void {
    if (s.k === 'block') { for (const inner of s.body) this.stmt(inner, depth); return; }
    this.stmt(s, depth);
  }

  /** A for-loop initializer has to render without a trailing semicolon. */
  private inlineStmt(s: Stmt): string {
    if (s.k === 'var') {
      const kw = s.isConst ? 'let' : 'var';
      const type = s.type ? `: ${typeToWgsl(s.type)}` : '';
      return `${kw} ${s.name}${type}${s.init ? ` = ${this.expr(s.init)}` : ''}`;
    }
    if (s.k === 'expr') return this.inlineExpr(s.expr);
    throw new Unsupported('unsupported for-loop initializer', s.pos);
  }

  private inlineExpr(e: Expr): string {
    if (e.k === 'incdec') return `${this.expr(e.target)}${e.op}`;
    return this.expr(e);
  }

  private expr(e: Expr): string {
    switch (e.k) {
      case 'num': return normalizeNumber(e.text);
      case 'bool': return e.value ? 'true' : 'false';
      case 'ident': return e.name;
      case 'member': {
        if (SWIZZLE.test(e.name)) {
          // WGSL keeps xyzw and rgba but forbids mixing the two sets.
          const xyzw = /^[xyzw]+$/.test(e.name);
          const rgba = /^[rgba]+$/.test(e.name);
          if (!xyzw && !rgba) throw new Unsupported(`mixed swizzle '${e.name}'`, e.pos);
        }
        return `${this.expr(e.target)}.${e.name}`;
      }
      case 'index': return `${this.expr(e.target)}[${this.expr(e.index)}]`;
      case 'unary': return `${e.op}(${this.expr(e.operand)})`;
      case 'binary': return `(${this.expr(e.left)} ${e.op} ${this.expr(e.right)})`;
      case 'ternary':
        // WGSL has no ?: operator; select() takes the false value first.
        return `select(${this.expr(e.else)}, ${this.expr(e.then)}, ${this.expr(e.cond)})`;
      case 'assign': return `${this.expr(e.target)} ${e.op} ${this.expr(e.value)}`;
      case 'incdec':
        throw new Unsupported('++ and -- are only supported as statements', e.pos);
      case 'call': return this.call(e);
    }
  }

  private call(e: Extract<Expr, { k: 'call' }>): string {
    const args = e.args.map((a) => this.expr(a));
    const ctor = typeCtor(e.callee);
    if (ctor) return `${ctor}(${args.join(', ')})`;
    if (this.funcNames.has(e.callee)) return `${e.callee}(${args.join(', ')})`;
    if (RENAMED[e.callee]) return `${RENAMED[e.callee]}(${args.join(', ')})`;
    if (SAME_NAME.has(e.callee)) return `${e.callee}(${args.join(', ')})`;
    // fmod has no WGSL builtin; '%' on floats is the same truncated remainder.
    if (e.callee === 'fmod' && args.length === 2) return `(${args[0]} % ${args[1]})`;
    throw new Unsupported(`unknown function '${e.callee}'`, e.pos);
  }
}

/** Slang accepts 1.0F and 1U; WGSL wants the suffix lowercase. */
function normalizeNumber(text: string): string {
  return text.replace(/[fF]$/, 'f').replace(/[uU]$/, 'u');
}

export function emit(mod: Module): { wgsl: string; entryName: string } {
  return new Emitter(mod).emit();
}
