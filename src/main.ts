// slangtoy entry point: boots WebGPU, loads the Slang compiler, and keeps the
// editor, compiler, and render loop in step.

import { GpuHost, UnsupportedError } from './gpu';
import { Editor } from './editor';
import { SlangCompiler, type Diag } from './compiler';
import { EXAMPLES, DEFAULT_EXAMPLE, findExample } from './examples';
import { encodeShareUrl, decodeShareUrl } from './share';

const statusEl = document.querySelector<HTMLElement>('#status')!;
const overlayEl = document.querySelector<HTMLElement>('#overlay')!;
const overlayTextEl = document.querySelector<HTMLElement>('#overlay-text')!;
const diagnosticsEl = document.querySelector<HTMLElement>('#diagnostics')!;
const editorHost = document.querySelector<HTMLElement>('#editor')!;
const canvas = document.querySelector<HTMLCanvasElement>('#gpu-canvas')!;
const pickerEl = document.querySelector<HTMLSelectElement>('#example-picker')!;
const shareEl = document.querySelector<HTMLButtonElement>('#share')!;

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

  // A shared link wins over the default; a broken one silently falls back.
  const shared = await decodeShareUrl();
  const editor = new Editor(editorHost, shared ?? DEFAULT_EXAMPLE.source, schedule);
  let pending: number | undefined;

  for (const example of EXAMPLES) {
    const option = document.createElement('option');
    option.value = example.id;
    option.textContent = example.label;
    pickerEl.appendChild(option);
  }
  if (shared) {
    const custom = document.createElement('option');
    custom.value = 'shared';
    custom.textContent = 'shared link';
    pickerEl.appendChild(custom);
    pickerEl.value = 'shared';
  }

  pickerEl.addEventListener('change', () => {
    const example = findExample(pickerEl.value);
    if (!example) return;
    // Loading an example invalidates the hash the page was opened with.
    history.replaceState(null, '', location.pathname);
    editor.setDoc(example.source);
  });

  shareEl.addEventListener('click', async () => {
    const url = await encodeShareUrl(editor.doc);
    history.replaceState(null, '', url);
    try {
      await navigator.clipboard.writeText(url);
      shareEl.textContent = 'copied';
    } catch {
      shareEl.textContent = 'link in url bar';
    }
    window.setTimeout(() => { shareEl.textContent = 'copy link'; }, 1600);
  });

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
