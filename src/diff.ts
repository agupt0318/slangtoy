// Differential test: the fast path against the official Slang compiler.
//
// Both compilers translate the same Slang source, both results render at
// identical uniforms into an offscreen texture, and the pixels are compared.
// The official compiler is the reference; any disagreement is a bug in the
// fast path. Open /diff.html to run it.

import { SlangCompiler } from './compiler';
import { EXAMPLES } from './examples';
import { compileFast } from './minislang';

const SIZE = 256;
const FIXED_TIME = 1.234;   // frozen so the two renders are comparable
const FIXED_FRAME = 42;

const VERTEX = `
@vertex
fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4<f32> {
  var p = array<vec2<f32>, 3>(vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
  return vec4<f32>(p[i], 0.0, 1.0);
}
`;

const log = (html: string) => {
  const el = document.querySelector('#out')!;
  el.innerHTML += html + '\n';
};

async function renderToPixels(
  device: GPUDevice,
  wgsl: string,
  entryName: string,
): Promise<Uint8Array> {
  const module = device.createShaderModule({ code: VERTEX + wgsl });
  const info = await module.getCompilationInfo();
  const errors = info.messages.filter((m) => m.type === 'error');
  if (errors.length) throw new Error(`WGSL rejected: ${errors[0].message}`);

  const texture = device.createTexture({
    size: [SIZE, SIZE],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC,
  });

  // Same layout the app uses: mouse@0, resolution@16, time@24, frame@28.
  const uniformData = new ArrayBuffer(32);
  const f32 = new Float32Array(uniformData);
  const u32 = new Uint32Array(uniformData);
  f32[4] = SIZE; f32[5] = SIZE;
  f32[6] = FIXED_TIME;
  u32[7] = FIXED_FRAME;
  const uniformBuffer = device.createBuffer({
    size: 32,
    usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
  });
  device.queue.writeBuffer(uniformBuffer, 0, uniformData);

  const pipeline = await device.createRenderPipelineAsync({
    layout: 'auto',
    vertex: { module, entryPoint: 'vs' },
    fragment: { module, entryPoint: entryName, targets: [{ format: 'rgba8unorm' }] },
    primitive: { topology: 'triangle-list' },
  });

  const bindGroup = device.createBindGroup({
    layout: pipeline.getBindGroupLayout(0),
    entries: [{ binding: 0, resource: { buffer: uniformBuffer } }],
  });

  const bytesPerRow = SIZE * 4;   // 256*4 = 1024, already a multiple of 256
  const readback = device.createBuffer({
    size: bytesPerRow * SIZE,
    usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ,
  });

  const encoder = device.createCommandEncoder();
  const pass = encoder.beginRenderPass({
    colorAttachments: [{
      view: texture.createView(),
      loadOp: 'clear',
      storeOp: 'store',
      clearValue: { r: 0, g: 0, b: 0, a: 1 },
    }],
  });
  pass.setPipeline(pipeline);
  pass.setBindGroup(0, bindGroup);
  pass.draw(3);
  pass.end();
  encoder.copyTextureToBuffer({ texture }, { buffer: readback, bytesPerRow }, [SIZE, SIZE]);
  device.queue.submit([encoder.finish()]);

  await readback.mapAsync(GPUMapMode.READ);
  const pixels = new Uint8Array(readback.getMappedRange()).slice();
  readback.unmap();
  return pixels;
}

function compare(a: Uint8Array, b: Uint8Array): { maxDelta: number; differing: number } {
  let maxDelta = 0;
  let differing = 0;
  for (let i = 0; i < a.length; i += 4) {
    let pixelDiff = 0;
    for (let c = 0; c < 3; c++) pixelDiff = Math.max(pixelDiff, Math.abs(a[i + c] - b[i + c]));
    if (pixelDiff > 0) differing++;
    maxDelta = Math.max(maxDelta, pixelDiff);
  }
  return { maxDelta, differing };
}

async function main(): Promise<void> {
  if (!navigator.gpu) { log('<b>WebGPU unavailable.</b>'); return; }
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) { log('<b>No WebGPU adapter.</b>'); return; }
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => log(`<span class="bad">device error: ${(e as GPUUncapturedErrorEvent).error.message}</span>`));

  log('loading the official Slang compiler...');
  const official = new SlangCompiler();
  await official.load((loaded, total) => {
    const pct = total ? Math.round((loaded / total) * 100) : 0;
    document.querySelector('#progress')!.textContent = `downloading slang ${pct}%`;
  });
  document.querySelector('#progress')!.textContent = `slang ${official.version}`;
  log('');

  let agreed = 0;
  let checked = 0;

  for (const ex of EXAMPLES) {
    const fast = compileFast(ex.source);
    if (!fast.ok) {
      log(`<span class="skip">SKIP  ${ex.id} — fast path declined: ${fast.reason}</span>`);
      continue;
    }
    const ref = official.compile(ex.source);
    if (!ref.ok) {
      log(`<span class="bad">ERROR ${ex.id} — official compiler failed</span>`);
      continue;
    }

    checked++;
    try {
      const [fastPixels, refPixels] = await Promise.all([
        renderToPixels(device, fast.wgsl, fast.entryName),
        renderToPixels(device, ref.wgsl, ref.entryName),
      ]);
      const { maxDelta, differing } = compare(fastPixels, refPixels);
      const total = SIZE * SIZE;
      // 8-bit channels quantise, so allow a 1/255 rounding difference.
      const ok = maxDelta <= 1;
      if (ok) agreed++;
      const cls = ok ? 'good' : 'bad';
      log(
        `<span class="${cls}">${ok ? 'MATCH' : 'DIFF '} ${ex.id.padEnd(11)}</span>` +
        ` max channel delta ${maxDelta}/255, ${differing}/${total} pixels differ`,
      );
    } catch (e) {
      log(`<span class="bad">ERROR ${ex.id} — ${e instanceof Error ? e.message : String(e)}</span>`);
    }
  }

  log('');
  log(`<b>${agreed}/${checked} examples match the official compiler.</b>`);
}

main().catch((e) => log(`<span class="bad">harness failed: ${e}</span>`));
