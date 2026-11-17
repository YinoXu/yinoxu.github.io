import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createHash,webcrypto} from 'node:crypto';
import {applyTLSBoundaries,loadTLSBoundaries,tlsRings,tlsBounds} from '../cell-tree/nuclass-reviewer/tls-boundaries.mjs';

globalThis.crypto??=webcrypto;
const root=new URL('../cell-tree/nuclass-reviewer/wholecell/',import.meta.url);
const bytes=p=>readFile(new URL(p,root));
const json=async p=>JSON.parse(await bytes(p));
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=await json('manifest-v6.json'),catalog=await json('TLS_BOUNDARIES_V2.json');
function inside([x,y],ring) {
  let hit=false;
  for(let i=0,j=ring.length-1;i<ring.length;j=i++) {
    const [a,b]=ring[i],[c,d]=ring[j];
    if((b>y)!==(d>y) && x<(c-a)*(y-b)/(d-b)+a) hit=!hit;
  }
  return hit;
}
const contains=(p,rings)=>rings.reduce((v,r)=>v!==inside(p,r),false);
let total=0;
for(const slide of ['S03','S07']) {
  const index=await json(`${slide}/analysis-v6.json`), original=structuredClone(index);
  const payload=await json(`${slide}/tls-boundaries-v2.json`), file=await bytes(catalog.files[slide].file);
  assert.equal(file.length,catalog.files[slide].bytes);assert.equal(hash(file),catalog.files[slide].sha256);
  applyTLSBoundaries(index,payload,manifest);
  for(const region of index.regions) {
    const baseline=original.regions.find(r=>r.id===region.id),{continuous_boundary,...rest}=region;
    assert.deepEqual(rest,baseline,'frozen metrics, stages and original geometry must not change');
    assert.deepEqual(tlsRings(region,'raw'),baseline.raw_rings||baseline.rings||[]);
    if(region.control) {assert.equal(continuous_boundary,undefined);continue;}
    total++;
    const rings=tlsRings(region,'continuous');
    assert.equal(rings.length,1);assert.deepEqual(rings[0][0],rings[0].at(-1));
    assert.equal(continuous_boundary.audit.holes,0);assert.equal(continuous_boundary.audit.components,1);
    assert.equal(tlsBounds(region,'continuous'),continuous_boundary.bounds);
    // Previously excluded interior holes are now selectable in the continuous mode.
    for(const hole of baseline.refined_rings.filter(r=>baseline.refined_rings.some(other=>other!==r&&inside(r[0],other)))) {
      assert(hole.every(p=>contains(p,rings)),`${region.id}: former interior hole must be inside envelope`);
    }
  }
  if(slide==='S07') {
    const r=index.regions.find(r=>r.id==='S07_C003');
    const p=[60922.23,21019.95]; // Middle of the old inward cleft, in native pixels.
    assert(!contains(p,tlsRings(r,'refined')),'regression point must expose the old cleft');
    assert(contains(p,tlsRings(r,'continuous')),'old C003 cleft must be closed and selectable');
  }
  for(const change of [p=>p.regions.pop(),p=>p.regions[0].id='wrong-id',p=>p.data_revision='wrong',
    p=>p.regions[0].rings[0].pop(),p=>p.regions[0].rings.push(p.regions[0].rings[0])]) {
    const bad=structuredClone(payload),untouched=structuredClone(original);change(bad);
    assert.throws(()=>applyTLSBoundaries(untouched,bad,manifest));
    assert.deepEqual(untouched,original,'invalid sidecars must not partially update candidates');
  }
}
assert.equal(total,189);
const actualFetch=globalThis.fetch;
try {
  let corrupt=false;
  globalThis.fetch=async url=>{
    const name=new URL(url).pathname.split('/wholecell/')[1];
    const body=await bytes(name);
    if(corrupt&&name.endsWith('tls-boundaries-v2.json'))body[10]^=1;
    return new Response(body);
  };
  await loadTLSBoundaries(await json('S07/analysis-v6.json'),manifest,new URL('https://example.test/wholecell/'));
  corrupt=true;
  // Explicitly exercise the real loader's hash rejection with a valid index.
  const index=await json('S07/analysis-v6.json');
  await assert.rejects(()=>loadTLSBoundaries(index,manifest,new URL('https://example.test/wholecell/')),/integrity/);
  assert(index.regions.every(r=>!r.continuous_boundary));
} finally {globalThis.fetch=actualFetch;}
console.log(`PASS: ${total} continuous candidates, original analyses preserved, hole/cleft picking, complete atomic revision and corrupted download rejection`);
