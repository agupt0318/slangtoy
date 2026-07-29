// slangtoy entry point. Boots the WebGPU host; the Slang compiler and editor
// arrive in later commits, so for now the fragment stage is hand-written WGSL.

import { GpuHost, UnsupportedError } from './gpu';

const statusEl = document.querySelector<HTMLElement>('#status')!;
const overlayEl = document.querySelector<HTMLElement>('#overlay')!;
const overlayTextEl = document.querySelector<HTMLElement>('#overlay-text')!;
const diagnosticsEl = document.querySelector<HTMLElement>('#diagnostics')!;
const canvas = document.querySelector<HTMLCanvasElement>('#gpu-canvas')!;

function setStatus(text: string, state?: 'ok' | 'error'): void {
  statusEl.textContent = text;
  if (state) statusEl.dataset.state = state;
  else delete statusEl.dataset.state;
}

function showOverlay(html: string): void {
  overlayTextEl.innerHTML = html;
  overlayEl.hidden = false;
}

/** Placeholder fragment stage: what the Slang compiler will emit in commit 5. */
const PLACEHOLDER_WGSL = /* wgsl */ `
struct Uniforms {
  mouse: vec4f,
  resolution: vec2f,
  time: f32,
  frame: u32,
};
@group(0) @binding(0) var<uniform> u: Uniforms;

@fragment
fn imageMain(@builtin(position) fragCoord: vec4f) -> @location(0) vec4f {
  var uv = fragCoord.xy / u.resolution;
  uv.y = 1.0 - uv.y;
  let phase = vec3f(0.0, 2.0, 4.0);
  let c = 0.5 + 0.5 * cos(u.time + (uv.x + uv.y) * 6.0 + phase);
  return vec4f(c, 1.0);
}
`;

async function boot(): Promise<void> {
  const host = new GpuHost(canvas);
  try {
    setStatus('starting webgpu');
    await host.init();
  } catch (e) {
    if (e instanceof UnsupportedError) {
      setStatus('webgpu unavailable', 'error');
      showOverlay(
        `${e.message}<br /><br />slangtoy needs WebGPU. Try a current version of ` +
          `Chrome, Edge, or Safari on desktop.`,
      );
      return;
    }
    throw e;
  }

  const errors = await host.setFragmentShader(PLACEHOLDER_WGSL, 'imageMain');
  if (errors.length) {
    setStatus('shader error', 'error');
    diagnosticsEl.innerHTML = errors
      .map((e) => `<div class="diag-error">${e.line ? `line ${e.line}: ` : ''}${e.message}</div>`)
      .join('');
    return;
  }
  setStatus('running', 'ok');
}

boot().catch((e) => {
  setStatus('boot failed', 'error');
  showOverlay(`Unexpected error while starting: ${e instanceof Error ? e.message : String(e)}`);
  console.error(e);
});
