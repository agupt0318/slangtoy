// slangtoy entry point: boots WebGPU, loads the Slang compiler, and keeps the
// editor, compiler, and render loop in step.

import { GpuHost, UnsupportedError } from './gpu';
import { Editor } from './editor';
import { SlangCompiler, type Diag } from './compiler';
import { EXAMPLES, DEFAULT_EXAMPLE, findExample } from './examples';
import { compileFast } from './minislang';
import { encodeShareUrl, decodeShareUrl } from './share';
import { Inspector } from './inspector';

const statusEl = document.querySelector<HTMLElement>('#status')!;
const overlayEl = document.querySelector<HTMLElement>('#overlay')!;
const overlayTextEl = document.querySelector<HTMLElement>('#overlay-text')!;
const diagnosticsEl = document.querySelector<HTMLElement>('#diagnostics')!;
const editorHost = document.querySelector<HTMLElement>('#editor')!;
const canvas = document.querySelector<HTMLCanvasElement>('#gpu-canvas')!;
const pickerEl = document.querySelector<HTMLSelectElement>('#example-picker')!;
const shareEl = document.querySelector<HTMLButtonElement>('#share')!;
const tabsEl = document.querySelector<HTMLElement>('#tabs')!;
const canvasHostEl = document.querySelector<HTMLElement>('#canvas-host')!;
const generatedEl = document.querySelector<HTMLElement>('#generated')!;

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

  // The editor comes up BEFORE the compiler download. Constructing SlangCompiler
  // is cheap; load() is the multi-megabyte part. Awaiting load() first left the
  // editor unbuilt for the whole download, so a cold visit showed an empty pane
  // and an empty canvas for tens of seconds, which reads as a broken page.
  const compiler = new SlangCompiler();
  let ready = false;

  // A shared link wins over the default; a broken one silently falls back.
  const shared = await decodeShareUrl();
  const editor = new Editor(editorHost, shared ?? DEFAULT_EXAMPLE.source, schedule);
  const inspector = new Inspector(tabsEl, canvasHostEl, generatedEl, compiler);
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
    // Until the official compiler finishes downloading, the built-in fast path
    // handles the subset it is confident about so the first frame does not wait
    // on 9.7 MB. Once the real compiler is ready it becomes the only source of
    // truth, so any gap in the subset is transient rather than baked in.
    let wgsl: string;
    let entryName: string;
    if (ready) {
      setStatus('compiling');
      const result = compiler.compile(editor.doc);
      if (!result.ok) {
        setStatus('slang error', 'error');
        renderDiagnostics(result.diagnostics);
        editor.setDiagnostics(result.diagnostics);
        return;
      }
      wgsl = result.wgsl;
      entryName = result.entryName;
    } else {
      const fast = compileFast(editor.doc);
      if (!fast.ok) {
        // Not an error the user needs to act on: the real compiler is coming.
        setStatus('waiting for slang');
        return;
      }
      setStatus('compiling (fast path)');
      wgsl = fast.wgsl;
      entryName = fast.entryName;
    }

    const result = { wgsl, entryName };

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
    inspector.setSource(editor.doc);
  }

  setStatus('downloading slang');
  await compiler.load((loaded, total) => {
    const mb = (loaded / 1e6).toFixed(1);
    setStatus(total ? `downloading slang ${Math.round((loaded / total) * 100)}%` : `downloading slang ${mb} MB`);
  });
  ready = true;
  setStatus(`slang ${compiler.version} ready`);

  await run();
}

boot().catch((e) => {
  setStatus('boot failed', 'error');
  showOverlay(`Unexpected error while starting: ${e instanceof Error ? e.message : String(e)}`);
  console.error(e);
});
