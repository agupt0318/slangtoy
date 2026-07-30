// The WebGPU host: owns the device, the fullscreen-triangle pass, and the
// render loop. User shaders only supply the fragment stage; everything else here
// is fixed so a broken shader can never take the canvas down.

import { Uniforms, UNIFORM_SIZE } from './uniforms';

/** Vertex stage is ours, never the user's: a fullscreen triangle from the index alone. */
const VERTEX_WGSL = /* wgsl */ `
@vertex
fn vsMain(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  let x = f32((i << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(i & 2u) * 2.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}
`;

export class UnsupportedError extends Error {}

export type ShaderError = { message: string; line?: number };

export class GpuHost {
  private device!: GPUDevice;
  private context!: GPUCanvasContext;
  private format!: GPUTextureFormat;
  private layout!: GPUPipelineLayout;
  private uniformBuffer!: GPUBuffer;
  private bindGroup!: GPUBindGroup;
  private vertexModule!: GPUShaderModule;

  /** Last pipeline that compiled cleanly; kept rendering while new code is broken. */
  private pipeline: GPURenderPipeline | null = null;
  private uniforms = new Uniforms();
  private running = false;

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async init(): Promise<void> {
    if (!navigator.gpu) {
      throw new UnsupportedError('This browser does not expose WebGPU.');
    }
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      throw new UnsupportedError('No WebGPU adapter is available on this machine.');
    }
    this.device = await adapter.requestDevice();
    this.device.lost.then((info) => {
      this.running = false;
      console.error('WebGPU device lost:', info.message);
    });

    const context = this.canvas.getContext('webgpu');
    if (!context) throw new UnsupportedError('Could not create a WebGPU canvas context.');
    this.context = context;
    this.format = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' });

    const bindGroupLayout = this.device.createBindGroupLayout({
      entries: [{ binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    });
    this.layout = this.device.createPipelineLayout({ bindGroupLayouts: [bindGroupLayout] });
    this.uniformBuffer = this.device.createBuffer({
      size: UNIFORM_SIZE,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    });
    this.bindGroup = this.device.createBindGroup({
      layout: bindGroupLayout,
      entries: [{ binding: 0, resource: { buffer: this.uniformBuffer } }],
    });
    this.vertexModule = this.device.createShaderModule({ code: VERTEX_WGSL });

    this.uniforms.track(this.canvas);
    this.observeSize();
  }

  /**
   * Swaps in a new fragment stage. Returns the validation errors WebGPU reports
   * for the generated WGSL; on failure the previous pipeline keeps rendering.
   */
  async setFragmentShader(wgsl: string, entryPoint: string): Promise<ShaderError[]> {
    this.device.pushErrorScope('validation');
    const module = this.device.createShaderModule({ code: wgsl });
    const info = await module.getCompilationInfo();

    let pipeline: GPURenderPipeline | null = null;
    let pipelineError: string | null = null;
    try {
      pipeline = await this.device.createRenderPipelineAsync({
        layout: this.layout,
        vertex: { module: this.vertexModule, entryPoint: 'vsMain' },
        fragment: { module, entryPoint, targets: [{ format: this.format }] },
        primitive: { topology: 'triangle-list' },
      });
    } catch (e) {
      pipelineError = e instanceof Error ? e.message : String(e);
    }
    const scoped = await this.device.popErrorScope();

    const errors: ShaderError[] = info.messages
      .filter((m) => m.type !== 'info')
      .map((m) => ({ message: m.message, line: m.lineNum || undefined }));
    if (pipelineError) errors.push({ message: pipelineError });
    if (scoped && !pipelineError) errors.push({ message: scoped.message });

    if (pipeline && errors.every((e) => e.message !== pipelineError)) {
      this.pipeline = pipeline;
      this.uniforms.reset();
      this.start();
    }
    return errors;
  }

  private observeSize(): void {
    const resize = () => {
      // While the canvas is display:none (the generated-code tabs hide it) the
      // observer reports 0x0. Keep the last real size instead of collapsing.
      if (this.canvas.clientWidth === 0 || this.canvas.clientHeight === 0) return;

      const dpr = window.devicePixelRatio || 1;
      const max = this.device.limits.maxTextureDimension2D;
      const w = Math.min(max, Math.round(this.canvas.clientWidth * dpr));
      const h = Math.min(max, Math.round(this.canvas.clientHeight * dpr));
      if (this.canvas.width !== w || this.canvas.height !== h) {
        this.canvas.width = w;
        this.canvas.height = h;
      }
    };
    resize();
    new ResizeObserver(resize).observe(this.canvas);
  }

  private start(): void {
    if (this.running) return;
    this.running = true;
    const frame = () => {
      if (!this.running) return;
      this.draw();
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }

  private draw(): void {
    if (!this.pipeline) return;
    const { width, height } = this.canvas;
    this.device.queue.writeBuffer(this.uniformBuffer, 0, this.uniforms.pack(width, height));

    const encoder = this.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [{
        view: this.context.getCurrentTexture().createView(),
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    });
    pass.setPipeline(this.pipeline);
    pass.setBindGroup(0, this.bindGroup);
    pass.draw(3);
    pass.end();
    this.device.queue.submit([encoder.finish()]);
  }
}
