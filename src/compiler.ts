// Wraps the Slang WebAssembly compiler. Everything that touches embind objects
// lives here, so the rest of the app only ever sees plain data.

import { inflate } from 'pako';
import type { MainModule, GlobalSession } from './vendor/slang-wasm';

/** Served straight from public/, so the 9 MB payload never enters a JS bundle. */
const WASM_URL = '/slang-wasm.wasm.gz';

/** Stage constant Slang uses for fragment/pixel entry points (SLANG_STAGE_FRAGMENT). */
const STAGE_FRAGMENT = 5;

export const ENTRY_POINT = 'imageMain';

export type Diag = { line?: number; message: string; severity: 'error' | 'warning' };

export type CompileResult =
  | { ok: true; wgsl: string; entryName: string; warnings: Diag[] }
  | { ok: false; diagnostics: Diag[] };

// Slang 2026.x reports diagnostics in a Rust-like block:
//
//   error[E30015]: undefined identifier
//     --> /user.slang:19:12
//      |
//   19 | return foo;
//      |        ^^^ 'foo' is not defined
//
const DIAG_HEAD = /^(error|warning)(?:\[(\w+)\])?:\s*(.*)$/;
const DIAG_LOCATION = /^\s*-->\s*\S*?:(\d+):(\d+)/;
/** Older builds emit the plain CLI form instead: `user.slang(19): error 30015: ...`. */
const DIAG_LEGACY = /^.*?\((\d+)\):\s*(error|warning)[^:]*:\s*(.*)$/;

function parseDiagnostics(raw: string): Diag[] {
  const out: Diag[] = [];
  let current: Diag | null = null;

  for (const line of raw.split('\n')) {
    const head = DIAG_HEAD.exec(line.trim());
    if (head) {
      current = { severity: head[1] as 'error' | 'warning', message: head[3] };
      out.push(current);
      continue;
    }
    if (current && !current.line) {
      const loc = DIAG_LOCATION.exec(line);
      if (loc) {
        current.line = Number(loc[1]);
        continue;
      }
    }
    const legacy = DIAG_LEGACY.exec(line.trim());
    if (legacy) {
      current = null;
      out.push({
        line: Number(legacy[1]),
        severity: legacy[2] as 'error' | 'warning',
        message: legacy[3],
      });
    }
  }

  // Never swallow a diagnostic just because the format changed upstream.
  if (out.length === 0 && raw.trim()) {
    out.push({ message: raw.trim(), severity: 'error' });
  }
  return out;
}

export class SlangCompiler {
  private module!: MainModule;
  private globalSession!: GlobalSession;
  private targets = new Map<string, number>();

  get version(): string {
    return this.module.getVersionString();
  }

  get availableTargets(): string[] {
    return [...this.targets.keys()];
  }

  /** Downloads and instantiates the compiler. Reports download progress in bytes. */
  async load(onProgress?: (loaded: number, total: number) => void): Promise<void> {
    const createModule = (await import('./vendor/slang-wasm.js')).default;

    this.module = (await createModule({
      instantiateWasm: async (
        imports: WebAssembly.Imports,
        receive: (instance: WebAssembly.Instance) => void,
      ) => {
        const payload = await fetchWithProgress(WASM_URL, onProgress);
        // Some servers (Vite's dev server, most CDNs) send the .gz with
        // Content-Encoding: gzip and the browser inflates it for us; others hand
        // over the raw file. Sniff the gzip magic number instead of guessing.
        const bytes = isGzip(payload) ? inflate(payload) : payload;
        const source = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        const { instance } = await WebAssembly.instantiate(source as ArrayBuffer, imports);
        receive(instance);
        return instance.exports;
      },
    })) as MainModule;

    const globalSession = this.module.createGlobalSession();
    if (!globalSession) throw new Error(this.lastError() || 'Could not create a Slang session.');
    this.globalSession = globalSession;

    for (const t of this.module.getCompileTargets() as { name: string; value: number }[]) {
      this.targets.set(t.name, t.value);
    }
    if (!this.targets.has('WGSL')) {
      throw new Error('This Slang build cannot emit WGSL, so nothing can run on WebGPU.');
    }
  }

  /** Compiles Slang source to the named target. One session per compile, one target per session. */
  compile(source: string, target = 'WGSL'): CompileResult {
    const targetValue = this.targets.get(target);
    if (targetValue === undefined) {
      return { ok: false, diagnostics: [{ message: `Unknown target ${target}`, severity: 'error' }] };
    }

    const cleanup: { delete(): void }[] = [];
    try {
      const session = this.globalSession.createSession(targetValue);
      if (!session) return this.fail();
      cleanup.push(session);

      const module = session.loadModuleFromSource(source, 'user', '/user.slang');
      if (!module) return this.fail();
      cleanup.push(module);

      const entryPoint = module.findAndCheckEntryPoint(ENTRY_POINT, STAGE_FRAGMENT);
      if (!entryPoint) return this.fail();
      cleanup.push(entryPoint);

      const composite = session.createCompositeComponentType([module, entryPoint]);
      if (!composite) return this.fail();
      cleanup.push(composite);

      const linked = composite.link();
      if (!linked) return this.fail();
      cleanup.push(linked);

      const code: string = linked.getEntryPointCode(0, 0);
      if (!code) return this.fail();

      // Read the emitted entry point name rather than assuming Slang preserved ours.
      const entryName = target === 'WGSL' ? extractWgslEntry(code) : ENTRY_POINT;
      if (!entryName) {
        return {
          ok: false,
          diagnostics: [{
            message: 'Compiled, but no @fragment entry point was found in the generated WGSL.',
            severity: 'error',
          }],
        };
      }
      return { ok: true, wgsl: code, entryName, warnings: [] };
    } catch (e) {
      return {
        ok: false,
        diagnostics: [{ message: e instanceof Error ? e.message : String(e), severity: 'error' }],
      };
    } finally {
      // embind handles are manual; release newest first.
      for (const handle of cleanup.reverse()) {
        try { handle.delete(); } catch { /* already gone */ }
      }
    }
  }

  private fail(): CompileResult {
    return { ok: false, diagnostics: parseDiagnostics(this.lastError()) };
  }

  private lastError(): string {
    const err = this.module.getLastError();
    return String(err?.message ?? '');
  }
}

function extractWgslEntry(wgsl: string): string | null {
  const m = /@fragment\s+fn\s+([A-Za-z_]\w*)/.exec(wgsl);
  return m ? m[1] : null;
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

async function fetchWithProgress(
  url: string,
  onProgress?: (loaded: number, total: number) => void,
): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch the Slang compiler (${response.status}).`);

  const total = Number(response.headers.get('content-length') ?? 0);
  if (!response.body || !onProgress) {
    return new Uint8Array(await response.arrayBuffer());
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.byteLength;
    // content-length describes the compressed body, so once the browser inflates
    // for us the received count can exceed it. Clamp rather than report >100%.
    onProgress(loaded, Math.max(total, loaded));
  }

  const out = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}
