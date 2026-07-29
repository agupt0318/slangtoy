// The uniform block every slangtoy shader receives, and the browser-side input
// tracking that fills it.
//
// Field order is largest-first so the packing is identical under WGSL's uniform
// address space rules and std140: mouse@0, resolution@16, time@24, frame@28.
// Keep this in sync with the `Uniforms` struct in the shader contract.

export const UNIFORM_SIZE = 32;

export class Uniforms {
  private readonly buffer = new ArrayBuffer(UNIFORM_SIZE);
  private readonly f32 = new Float32Array(this.buffer);
  private readonly u32 = new Uint32Array(this.buffer);

  private startTime = performance.now();
  private frame = 0;

  /** Cursor position in canvas pixels, y measured from the top. */
  private mouseX = 0;
  private mouseY = 0;
  /** Position of the last press, negated while the button is up (Shadertoy convention). */
  private clickX = 0;
  private clickY = 0;
  private down = false;

  /** Attaches pointer listeners; returns a disposer. */
  track(canvas: HTMLCanvasElement): () => void {
    const toCanvas = (e: PointerEvent): [number, number] => {
      const r = canvas.getBoundingClientRect();
      const scale = canvas.width / r.width;
      return [(e.clientX - r.left) * scale, (e.clientY - r.top) * scale];
    };
    const onDown = (e: PointerEvent) => {
      [this.mouseX, this.mouseY] = toCanvas(e);
      this.clickX = this.mouseX;
      this.clickY = this.mouseY;
      this.down = true;
    };
    const onMove = (e: PointerEvent) => {
      if (this.down) [this.mouseX, this.mouseY] = toCanvas(e);
    };
    const onUp = () => { this.down = false; };

    canvas.addEventListener('pointerdown', onDown);
    canvas.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }

  reset(): void {
    this.startTime = performance.now();
    this.frame = 0;
  }

  /** Repacks for the current frame and returns the bytes to upload. */
  pack(width: number, height: number): ArrayBuffer {
    const sign = this.down ? 1 : -1;
    this.f32[0] = this.mouseX;
    this.f32[1] = this.mouseY;
    this.f32[2] = sign * this.clickX;
    this.f32[3] = sign * this.clickY;
    this.f32[4] = width;
    this.f32[5] = height;
    this.f32[6] = (performance.now() - this.startTime) / 1000;
    this.u32[7] = this.frame++;
    return this.buffer;
  }
}
