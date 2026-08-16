import { EXAMPLES } from '../src/examples';
import { compileFast } from '../src/minislang/index';
const id = process.argv[2] ?? 'gradient';
const ex = EXAMPLES.find((e) => e.id === id)!;
const r = compileFast(ex.source);
console.log(r.ok ? r.wgsl : `FAIL: ${r.reason}`);
