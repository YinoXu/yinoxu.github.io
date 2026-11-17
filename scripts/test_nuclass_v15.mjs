// Check the shipped loader and resolution logic against the frozen v15 oracle.
// Usage: node scripts/test_nuclass_v15.mjs DATA_CHECKOUT ROLLUP_ORACLE.json
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {webcrypto} from 'node:crypto';
import {loadPointBinary,loadPointIndex,validatePointBase} from '../cell-tree/nuclass-reviewer/point-data.mjs';
import {makeResolutionTable,resolveCells} from '../cell-tree/nuclass-reviewer/resolution.mjs';
const [dataRoot,oraclePath]=process.argv.slice(2);
assert(dataRoot&&oraclePath,'Pass the data checkout and independent v15 rollup oracle');
globalThis.crypto??=webcrypto;
const manifest=JSON.parse(await readFile(new URL('../cell-tree/nuclass-reviewer/data/manifest-v15.json',import.meta.url)));
const expected=JSON.parse(await readFile(oraclePath));
const table=makeResolutionTable(manifest.taxonomy),base=manifest.point_base;
validatePointBase(base);
assert.throws(()=>validatePointBase(base.replace(manifest.data_revision,'main')));
assert.equal(manifest.provenance.sourceModel.name,'NuClass v15');
assert.equal(manifest.provenance.sourceModel.step,59712);
// Only this offline test redirects transport; production browser checks use
// the actual immutable public URLs without interception.
globalThis.fetch=async(url,{signal}={})=>{
  signal?.throwIfAborted();
  assert(String(url).startsWith(base));
  return new Response(await readFile(resolve(dataRoot,'points-v15',String(url).slice(base.length))));
};
for(const slide of manifest.slides){
  const meta=await loadPointIndex(manifest.remote_indexes[slide.id],base);
  const cells=await loadPointBinary(meta.point_cells,base);
  const n=new DataView(cells).getUint32(0,true),leaves=new Uint8Array(cells,4+n*8,n);
  assert.equal(n,slide.valid);assert.equal(meta.point_model.sha256,manifest.provenance.sourceModel.sha256);
  const supportBuffer=await loadPointBinary(meta.point_support,base);
  assert.equal(new DataView(supportBuffer).getUint32(0,true),n);
  assert.equal(new DataView(supportBuffer).getUint32(4,true),table.slots);
  const support=new Uint8Array(supportBuffer,8);
  for(const mode of ['fine','lineage','broad'])for(let step=0;step<20;step++){
    const labels=resolveCells(leaves,support,table,mode,step);
    assert.equal(labels.length,n);
    const counts=Array(manifest.taxonomy.nodes.length).fill(0);
    for(const node of labels)counts[node]++;
    assert.deepEqual(counts,expected[slide.id][mode][step],`${slide.id} ${mode} ${step/20}`);
  }
  assert.deepEqual(resolveCells(leaves,support,table,'fine',0),leaves);
  const count=Array(47).fill(0);for(const leaf of leaves)count[leaf]++;
  assert.deepEqual(count,slide.counts);
  const corrupt={...manifest.remote_indexes[slide.id],sha256:'0'.repeat(64)};
  await assert.rejects(loadPointBinary(corrupt,base),/integrity/);
  const controller=new AbortController();controller.abort();
  await assert.rejects(loadPointBinary(meta.point_support,base,controller.signal),{name:'AbortError'});
  console.log(`PASS ${slide.id}: ${n} v15 nuclei; all 60 settings match the independent oracle; integrity and abort checks.`);
}
