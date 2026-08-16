// Compiles every built-in example with the fast path and reports what it can
// and cannot handle. Run: npx tsx scripts/check-fastpath.ts
import { EXAMPLES } from '../src/examples';
import { compileFast } from '../src/minislang/index';

let pass = 0;
for (const ex of EXAMPLES) {
  const r = compileFast(ex.source);
  if (r.ok) {
    pass++;
    console.log(`PASS  ${ex.id.padEnd(10)} entry=${r.entryName}  ${r.wgsl.split('\n').length} lines`);
  } else {
    const line = ex.source.slice(0, r.pos).split('\n').length;
    console.log(`FAIL  ${ex.id.padEnd(10)} line ${line}: ${r.reason}`);
  }
}
console.log(`\n${pass}/${EXAMPLES.length} examples compiled by the fast path`);
