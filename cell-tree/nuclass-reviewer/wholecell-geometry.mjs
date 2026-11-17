import earcut from './vendor/earcut.mjs';

export function insideRing(x,y,ring){let hit=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
  const a=ring[i],b=ring[j];if((a[1]>y)!==(b[1]>y)&&x<(b[0]-a[0])*(y-a[1])/(b[1]-a[1])+a[0])hit=!hit;
}return hit;}
function simplifyOpen(points,epsilon){
  const keep=new Uint8Array(points.length);keep[0]=keep[points.length-1]=1;const work=[[0,points.length-1]],sq=epsilon*epsilon;
  while(work.length){const [a,b]=work.pop(),p=points[a],q=points[b],dx=q[0]-p[0],dy=q[1]-p[1],den=dx*dx+dy*dy;let max=sq,index=-1;
    for(let i=a+1;i<b;i++){const v=points[i],t=den?Math.max(0,Math.min(1,((v[0]-p[0])*dx+(v[1]-p[1])*dy)/den)):0,d=(v[0]-p[0]-t*dx)**2+(v[1]-p[1]-t*dy)**2;if(d>max){max=d;index=i;}}
    if(index>=0){keep[index]=1;work.push([a,index],[index,b]);}
  }return points.filter((_,i)=>keep[i]);
}
export function simplifyRing(points,epsilon){
  if(!epsilon||points.length<=3)return points;
  let far=1,max=-1;for(let i=1;i<points.length;i++){const d=(points[i][0]-points[0][0])**2+(points[i][1]-points[0][1])**2;if(d>max){max=d;far=i;}}
  for(let e=epsilon;e>epsilon/64;e/=2){const a=simplifyOpen(points.slice(0,far+1),e),b=simplifyOpen([...points.slice(far),points[0]],e),r=[...a.slice(0,-1),...b.slice(0,-1)];if(r.length>=3)return r;}
  return points;
}
export function cellRings(chunk,cell){
  const r=chunk.record(cell),f=r.field*4,result=[];
  if(!chunk.ringIndex){chunk.ringIndex=Array.from({length:chunk.n},()=>[]);for(let j=0;j<chunk.nr;j++)chunk.ringIndex[chunk.part(j).cell].push(j);}
  for(const j of chunk.ringIndex[cell]){const p=chunk.part(j),xy=[];
    for(let k=0;k<p.count;k++){const i=(p.start+k)*2;xy.push([chunk.fields[f]+chunk.points[i]*chunk.fields[f+2],chunk.fields[f+1]+chunk.points[i+1]*chunk.fields[f+3]]);}
    result.push({kind:p.kind,xy});
  }return result;
}
const q=v=>Math.round(Math.max(0,Math.min(1,Number.isFinite(v)?v:0))*255);
function paint(d,o,r,kind){d.setUint8(o,r.leaf);d.setUint8(o+1,r.cellstp);d.setUint8(o+2,((r.flags&1)?1:0)+((r.flags&64)?2:0));d.setUint8(o+3,kind);
  d.setUint8(o+4,q(r.features[3]));d.setUint8(o+5,q(Math.log2(Math.max(1,r.features[0])/32)/4));d.setUint8(o+6,q(r.features[8]/10));}

// Native rings and holes are retained. Overview simplification is drawing-only;
// it never changes the source masks, identities, measurements or posterior files.
export function buildRenderGeometry(chunk,{tolerance=0,compact=false}={}){
  const grouped=Array.from({length:chunk.n},()=>[]);let segments=0;
  if(!chunk.ringIndex){chunk.ringIndex=Array.from({length:chunk.n},()=>[]);for(let j=0;j<chunk.nr;j++)chunk.ringIndex[chunk.part(j).cell].push(j);}
  let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
  for(let j=0;j<chunk.nr;j++){const p=chunk.part(j),r=chunk.record(p.cell),f=r.field*4,xy=[];
    for(let k=0;k<p.count;k++){const i=(p.start+k)*2;xy.push([chunk.fields[f]+chunk.points[i]*chunk.fields[f+2],chunk.fields[f+1]+chunk.points[i+1]*chunk.fields[f+3]]);}
    // Keep every ring native when a cell has holes; a simplified outer ring
    // must never strand or cover one of its original holes.
    const hasHoles=chunk.ringIndex?.[p.cell]?.some(k=>chunk.part(k).kind===p.kind%2+2);
    const points=simplifyRing(xy,hasHoles?0:tolerance);if(points.length<2)continue;
    for(const [x,y] of points){minX=Math.min(minX,x);minY=Math.min(minY,y);maxX=Math.max(maxX,x);maxY=Math.max(maxY,y);}
    grouped[p.cell].push({kind:p.kind,xy:points});segments+=points.length;
  }
  const polygons=[];let vertices=0;
  for(let i=0;i<chunk.n;i++)for(const kind of [0,1]){
    const rings=grouped[i],outers=rings.filter(r=>r.kind===kind&&r.xy.length>=3),holes=rings.filter(r=>r.kind===kind+2&&r.xy.length>=3);
    for(const outer of outers){const coordinates=outer.xy.flat(),starts=[];for(const hole of holes)if(insideRing(...hole.xy[0],outer.xy)){starts.push(coordinates.length/2);for(const p of hole.xy)coordinates.push(...p);}
      const triangles=earcut(coordinates,starts,2);vertices+=triangles.length;polygons.push({cell:i,kind,coordinates,triangles});
    }
  }
  const origin=compact&&segments?[minX,minY]:[0,0],units=compact&&segments?[Math.max(1e-8,maxX-minX)/65535,Math.max(1e-8,maxY-minY)/65535]:[1,1];
  const lineStride=compact?16:24,fillStride=compact?12:16;
  const lines=new ArrayBuffer(segments*lineStride),fills=new ArrayBuffer(vertices*fillStride),ld=new DataView(lines),fd=new DataView(fills);
  function point(d,o,x,y){if(compact){d.setUint16(o,Math.round((x-origin[0])/units[0]),true);d.setUint16(o+2,Math.round((y-origin[1])/units[1]),true);}else{d.setFloat32(o,x,true);d.setFloat32(o+4,y,true);}}
  let line=0;for(let i=0;i<chunk.n;i++){const r=chunk.record(i);for(const ring of grouped[i])for(let k=0;k<ring.xy.length;k++){
    const a=ring.xy[k],b=ring.xy[(k+1)%ring.xy.length],o=line++*lineStride;point(ld,o,...a);point(ld,o+(compact?4:8),...b);paint(ld,o+(compact?8:16),r,ring.kind);
  }}
  let vertex=0;for(const p of polygons){const r=chunk.record(p.cell);for(const t of p.triangles){const o=vertex++*fillStride;point(fd,o,p.coordinates[t*2],p.coordinates[t*2+1]);paint(fd,o+(compact?4:8),r,p.kind);}}
  return {lines,fills,lineCount:segments,fillCount:vertices,lineStride,fillStride,compact,origin,units,cells:chunk.n,rings:chunk.nr};
}
export function packOverview(g){
  const out=new Uint8Array(48+g.lines.byteLength+g.fills.byteLength),d=new DataView(out.buffer);out.set([87,67,79,49]);
  d.setUint32(4,g.cells,true);d.setUint32(8,g.lineCount,true);d.setUint32(12,g.fillCount,true);
  for(const [i,v] of [...g.origin,...g.units].entries())d.setFloat64(16+i*8,v,true);
  out.set(new Uint8Array(g.lines),48);out.set(new Uint8Array(g.fills),48+g.lines.byteLength);return out;
}
export function parseOverview(buffer){
  const d=new DataView(buffer);if(d.getUint32(0,true)!==0x314f4357)throw Error('Invalid overview geometry');
  const cells=d.getUint32(4,true),lineCount=d.getUint32(8,true),fillCount=d.getUint32(12,true),offset=48+lineCount*16;
  if(offset+fillCount*12!==buffer.byteLength||cells>200000||lineCount>10000000||fillCount>30000000)throw Error('Incomplete overview geometry');
  return {cells,lineCount,fillCount,lineStride:16,fillStride:12,compact:true,origin:[d.getFloat64(16,true),d.getFloat64(24,true)],units:[d.getFloat64(32,true),d.getFloat64(40,true)],
    lines:new Uint8Array(buffer,48,lineCount*16),fills:new Uint8Array(buffer,offset,fillCount*12),buffer};
}
