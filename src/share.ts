// Permalinks. The shader is deflated and base64url-encoded into the URL hash, so
// a link carries the whole program and nothing is stored server-side.
//
// Uses the platform CompressionStream rather than a library: anything with WebGPU
// already has it, and it keeps the dependency list at zero for this feature.

const PREFIX = '#s=';

/** Runs bytes through a compression transform and concatenates the output. */
async function pipe(
  bytes: Uint8Array<ArrayBuffer>,
  transform: 'deflate-raw',
  mode: 'c' | 'd',
): Promise<Uint8Array<ArrayBuffer>> {
  const stream = mode === 'c' ? new CompressionStream(transform) : new DecompressionStream(transform);
  const writer = stream.writable.getWriter();
  void writer.write(bytes);
  void writer.close();
  const chunks: Uint8Array[] = [];
  const reader = stream.readable.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  const total = chunks.reduce((n, c) => n + c.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/');
  // atob needs the length to be a multiple of 4; base64url drops the padding.
  const pad = (4 - (base64.length % 4)) % 4;
  const binary = atob(base64 + '='.repeat(pad));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/** Builds a shareable absolute URL for the given source. */
export async function encodeShareUrl(source: string): Promise<string> {
  const packed = await pipe(new TextEncoder().encode(source), 'deflate-raw', 'c');
  return `${location.origin}${location.pathname}${PREFIX}${toBase64Url(packed)}`;
}

/** Reads a shader out of the current URL hash, or null if there isn't one. */
export async function decodeShareUrl(): Promise<string | null> {
  if (!location.hash.startsWith(PREFIX)) return null;
  try {
    const packed = fromBase64Url(location.hash.slice(PREFIX.length));
    const bytes = await pipe(packed, 'deflate-raw', 'd');
    return new TextDecoder().decode(bytes);
  } catch {
    // A truncated or hand-edited link should fall back to the default shader
    // rather than breaking the whole page.
    return null;
  }
}
