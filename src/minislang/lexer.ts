// Tokenizer for the Slang subset. Positions are byte offsets into the source so
// the parser can report a line and column that lines up with the editor.

export type TokKind = 'ident' | 'number' | 'string' | 'punct' | 'eof';

export interface Tok {
  kind: TokKind;
  text: string;
  pos: number;
}

export class LexError extends Error {
  constructor(message: string, readonly pos: number) {
    super(message);
  }
}

// Longest first: '<<=' must win over '<<', which must win over '<'.
const PUNCT = [
  '<<=', '>>=',
  '&&', '||', '==', '!=', '<=', '>=', '++', '--', '<<', '>>',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=',
  '(', ')', '{', '}', '[', ']', '<', '>', ';', ',', '.', ':', '?',
  '+', '-', '*', '/', '%', '=', '!', '&', '|', '^', '~',
];

const isIdentStart = (c: string) => /[A-Za-z_]/.test(c);
const isIdentPart = (c: string) => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string) => c >= '0' && c <= '9';

export function lex(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue; }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const start = i;
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      if (i >= src.length) throw new LexError('unterminated block comment', start);
      i += 2;
      continue;
    }

    if (c === '"') {
      const start = i++;
      let text = '';
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\n') throw new LexError('unterminated string', start);
        text += src[i++];
      }
      if (i >= src.length) throw new LexError('unterminated string', start);
      i++;
      toks.push({ kind: 'string', text, pos: start });
      continue;
    }

    // A leading '.' is only part of a number when a digit follows, so member
    // access on a vector ('uv.x') still lexes as punct + ident.
    if (isDigit(c) || (c === '.' && isDigit(src[i + 1] ?? ''))) {
      const start = i;
      while (i < src.length && isDigit(src[i])) i++;
      if (src[i] === '.') { i++; while (i < src.length && isDigit(src[i])) i++; }
      if (src[i] === 'e' || src[i] === 'E') {
        i++;
        if (src[i] === '+' || src[i] === '-') i++;
        if (!isDigit(src[i] ?? '')) throw new LexError('malformed exponent', start);
        while (i < src.length && isDigit(src[i])) i++;
      }
      if (src[i] === 'f' || src[i] === 'F' || src[i] === 'u' || src[i] === 'U') i++;
      toks.push({ kind: 'number', text: src.slice(start, i), pos: start });
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      while (i < src.length && isIdentPart(src[i])) i++;
      toks.push({ kind: 'ident', text: src.slice(start, i), pos: start });
      continue;
    }

    const punct = PUNCT.find((p) => src.startsWith(p, i));
    if (punct) {
      toks.push({ kind: 'punct', text: punct, pos: i });
      i += punct.length;
      continue;
    }

    throw new LexError(`unexpected character ${JSON.stringify(c)}`, i);
  }

  toks.push({ kind: 'eof', text: '', pos: src.length });
  return toks;
}
