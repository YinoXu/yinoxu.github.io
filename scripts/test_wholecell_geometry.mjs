import assert from 'node:assert/strict';
import {buildRenderGeometry,packOverview,parseOverview,insideRing} from '../cell-tree/nuclass-reviewer/wholecell-geometry.mjs';

// A cell with a genuine hole, a disconnected component, and a separate nucleus.
// Check the filled area and the empty hole independently of the triangulator.
const rings=[
  {kind:0,xy:[[0,0],[10,0],[10,10],[0,10]]},
  {kind:2,xy:[[3,3],[3,7],[7,7],[7,3]]},
  {kind:0,xy:[[12,0],[14,0],[14,2],[12,2]]},
  {kind:1,xy:[[1,1],[2,1],[2,2],[1,2]]}
];
const points=new Uint16Array(rings.flatMap(r=>r.xy.flat())),parts=[];let offset=0;
for(const ring of rings){parts.push({cell:0,start:offset,count:ring.xy.length,kind:ring.kind});offset+=ring.xy.length;}
const features=new Float32Array(16);features[0]=89;features[3]=1/89;
const chunk={n:1,nr:parts.length,np:offset,fields:new Float64Array([0,0,1,1]),points,part:i=>parts[i],record:()=>({field:0,leaf:3,cellstp:7,flags:1,features})};
function triangles(g,kind){const data=g.fills instanceof ArrayBuffer?new DataView(g.fills):new DataView(g.fills.buffer,g.fills.byteOffset,g.fills.byteLength),result=[];
  for(let i=0;i<g.fillCount;i+=3){const o=i*g.fillStride,style=g.compact?4:8;if(data.getUint8(o+style+3)!==kind)continue;const t=[];
    for(let j=0;j<3;j++){const p=o+j*g.fillStride;t.push(g.compact?[g.origin[0]+data.getUint16(p,true)*g.units[0],g.origin[1]+data.getUint16(p+2,true)*g.units[1]]:[data.getFloat32(p,true),data.getFloat32(p+4,true)]);}
    result.push(t);
  }return result;
}
const area=items=>items.reduce((sum,[a,b,c])=>sum+Math.abs((b[0]-a[0])*(c[1]-a[1])-(b[1]-a[1])*(c[0]-a[0]))/2,0);
for(const compact of [false,true]){
  const geometry=buildRenderGeometry(chunk,{compact,tolerance:compact?2:0}),g=compact?parseOverview(packOverview(geometry).buffer):geometry;
  assert.equal(g.lineCount,16,'every ring, including the hole and component, has its closed outline');
  assert.ok(Math.abs(area(triangles(g,0))-88)<.01,'whole-cell area is 100 - 16 + 4');
  assert.ok(Math.abs(area(triangles(g,1))-1)<.002,'nuclear fill is independent of cell fill');
  assert.ok(!triangles(g,0).some(t=>insideRing(5.1,5.2,t)),'hole remains unfilled');
  assert.ok(triangles(g,0).some(t=>insideRing(12.3,.7,t)),'disconnected component stays filled');
  if(compact)assert.throws(()=>parseOverview(packOverview(geometry).buffer.slice(0,-1)),/Incomplete/);
}
console.log('PASS: native and compact polygon fills preserve holes, components, compartments and complete outlines');
