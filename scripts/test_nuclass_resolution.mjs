import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {gunzipSync} from 'node:zlib';
import {resolve} from 'node:path';
import {makeResolutionTable,resolveCells} from '../cell-tree/nuclass-reviewer/resolution.mjs';
const source=process.argv[2];assert(source,'Pass the original showcase folder');
const base=new URL('../cell-tree/nuclass-reviewer/data/',import.meta.url);
const manifest=JSON.parse(readFileSync(new URL('manifest.json',base)));
const cohort=JSON.parse(readFileSync(resolve(source,'data/COHORT.json')));
const table=makeResolutionTable(manifest.taxonomy);
for(const slide of manifest.slides){
  const cells=gunzipSync(readFileSync(new URL(`${slide.id}/cells.bin.gz`,base)));
  const n=cells.readUInt32LE(0),leaves=new Uint8Array(cells.buffer,cells.byteOffset+4+n*8,n);
  const packed=gunzipSync(readFileSync(new URL(`${slide.id}/support.bin.gz`,base)));
  assert.equal(packed.readUInt32LE(0),n);assert.equal(packed.readUInt32LE(4),table.slots);
  const support=new Uint8Array(packed.buffer,packed.byteOffset+8,packed.length-8);
  const expected=cohort.slides.find(s=>s.id===slide.id).counts;
  for(const [mi,mode] of ['broad','lineage','fine'].entries())for(let step=0;step<20;step++){
    const labels=resolveCells(leaves,support,table,mode,step),counts=Array(manifest.taxonomy.nodes.length).fill(0);
    for(const node of labels)counts[node]++;
    assert.equal(labels.length,n);assert.deepEqual(counts,expected[mi][step],`${slide.id} ${mode} ${step/20}`);
  }
  assert.deepEqual(resolveCells(leaves,null,table,'fine',0),leaves);
  console.log(`${slide.id}: 60 settings match original counts; ${n.toLocaleString()} cells retained; zero restores every leaf.`);
}
// Exact threshold boundary: a support byte of 15 includes 0.75, then rolls up.
const li=manifest.taxonomy.leaves.indexOf('CD4_T'),one=Uint8Array.of(li),caps=new Uint8Array(table.slots).fill(19);caps[0]=15;
assert.equal(resolveCells(one,caps,table,'fine',15)[0],li);
assert.equal(resolveCells(one,caps,table,'fine',16)[0],manifest.taxonomy.nodes.indexOf('T_cell'));
assert.throws(()=>resolveCells(one,null,table,'fine',15));
console.log('Boundary and missing-support checks passed.');
