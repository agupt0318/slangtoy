// slangtoy entry point: boots WebGPU, loads the Slang compiler, and keeps the
// editor, compiler, and render loop in step.

import { GpuHost, UnsupportedError } from './gpu';
import { Editor } from './editor';
import { SlangCompiler, ENTRY_POINT, type Diag } from './compiler';

const statusEl = document.querySelector<HTMLElement>('#status')!;
const overlayEl = document.querySelector<HTMLElement>('#overlay')!;
const overlayTextEl = document.querySelector<HTMLElement>('#overlay-text')!;
const diagnosticsEl = document.querySelector<HTMLElement>('#diagnostics')!;
const editorHost = document.querySelector<HTMLElement>('#editor')!;
const canvas = document.querySelector<HTMLCanvasElement>('#gpu-canvas')!;

/** The shader contract, spelled out in full so editor lines map 1:1 to compiler lines. */
const DEFAULT_SLANG = `struct Uniforms
{
    float4 mouse;       // xy: cursor while pressed, zw: last press (negated when up)
    float2 resolution;  // canvas size in pixels
    float  time;        // seconds since the shader started
    uint   frame;       // frames drawn
};
ConstantBuffer<Uniforms> u;

[shader("fragment")]
float4 ${ENTRY_POINT}(float4 fragCoord : SV_Position) : SV_Target
{
    // WebGPU puts y at the top, so flip it to get Shadertoy-style coords.
    float2 uv = fragCoord.xy / u.resolution;
    uv.y = 1.0 - uv.y;

    float3 phase = float3(0.0, 2.0, 4.0);
    float3 color = 0.5 + 0.5 * cos(u.time + (uv.x + uv.y) * 6.0 + phase);
    return float4(color, 1.0);
}
`;

function setStatus(text: string, state?: 'ok' | 'error'): void {
  statusEl.textContent = text;
  if (state) statusEl.dataset.state = state;
  else delete statusEl.dataset.state;
}

function showOverlay(html: string): void {
  overlayTextEl.innerHTML = html;
  overlayEl.hidden = false;
}

function renderDiagnostics(items: Diag[]): void {
  diagnosticsEl.replaceChildren(
    ...items.map((d) => {
      const row = document.createElement('div');
      row.className = d.severity === 'warning' ? 'diag-warn' : 'diag-error';
      row.textContent = (d.line ? `line ${d.line}: ` : '') + d.message;
      return row;
    }),
  );
}

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

  const compiler = new SlangCompiler();
  setStatus('downloading slang');
  await compiler.load((loaded, total) => {
    const mb = (loaded / 1e6).toFixed(1);
    setStatus(total ? `downloading slang ${Math.round((loaded / total) * 100)}%` : `downloading slang ${mb} MB`);
  });
  setStatus(`slang ${compiler.version} ready`);

  const editor = new Editor(editorHost, DEFAULT_SLANG, schedule);
  let pending: number | undefined;

  function schedule(): void {
    window.clearTimeout(pending);
    pending = window.setTimeout(run, 300);
  }

  async function run(): Promise<void> {
    setStatus('compiling');
    const result = compiler.compile(editor.doc);
    if (!result.ok) {
      setStatus('slang error', 'error');
      renderDiagnostics(result.diagnostics);
      editor.setDiagnostics(result.diagnostics);
      return;
    }

    const gpuErrors = await host.setFragmentShader(result.wgsl, result.entryName);
    if (gpuErrors.length) {
      setStatus('wgsl rejected', 'error');
      renderDiagnostics(gpuErrors.map((e) => ({ ...e, severity: 'error' as const })));
      editor.setDiagnostics([]);
      return;
    }

    setStatus('running', 'ok');
    renderDiagnostics([]);
    editor.setDiagnostics([]);
  }

  await run();
}

boot().catch((e) => {
  setStatus('boot failed', 'error');
  showOverlay(`Unexpected error while starting: ${e instanceof Error ? e.message : String(e)}`);
  console.error(e);
});
