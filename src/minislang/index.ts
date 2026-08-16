// The fast path: a Slang-subset compiler that runs with no download at all.
//
// Why it exists: the official Slang compiler is a 9.7 MB WASM payload, so a
// cold visit waits on a large download before the first pixel. Most shaders
// people write here use a small corner of the language, and that corner is
// cheap to translate directly.
//
// The contract this file guarantees: either it returns WGSL it is confident
// about, or it returns ok:false with a reason. It never guesses. A wrong
// translation would compile and draw the wrong image, which is worse than
// waiting for the real compiler.

import { emit } from './emit';
import { parse, Unsupported } from './parser';

export type FastResult =
  | { ok: true; wgsl: string; entryName: string }
  | { ok: false; reason: string; pos: number };

export function compileFast(source: string): FastResult {
  try {
    return { ok: true, ...emit(parse(source)) };
  } catch (e) {
    if (e instanceof Unsupported) return { ok: false, reason: e.message, pos: e.pos };
    // A bug in this compiler must not take the page down; the official
    // compiler is still there to produce the real answer.
    return { ok: false, reason: e instanceof Error ? e.message : String(e), pos: 0 };
  }
}

export { Unsupported } from './parser';
