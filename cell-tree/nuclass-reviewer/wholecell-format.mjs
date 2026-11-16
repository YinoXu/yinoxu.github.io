// Integer contours, physical transform and explicit per-cell prediction provenance.
export const FEATURE_COUNT=16, RECORD_BYTES=24+FEATURE_COUNT*4+24;
export function parseWholeCell(buffer){
  let d=new DataView(buffer);const magic=String.fromCharCode(...new Uint8Array(buffer,0,4));
  if(!['WCV6','WCS6'].includes(magic))throw Error('Unsupported whole-cell geometry');
  const n=d.getUint32(4,true),nr=d.getUint32(8,true),np=d.getUint32(12,true),nf=d.getUint32(16,true),stride=d.getUint32(20,true);
  if(stride!==RECORD_BYTES||n>200000||nr>1000000||np>10000000||nf>65536)throw Error('Invalid whole-cell header');
  const fieldsOffset=24,recordsOffset=fieldsOffset+nf*32,partsOffset=recordsOffset+n*stride,pointsOffset=partsOffset+nr*16;
  if(pointsOffset+np*4!==buffer.byteLength)throw Error('Incomplete whole-cell geometry');
  if(magic==='WCS6'){
    const source=new Uint8Array(buffer),out=new Uint8Array(buffer.byteLength);out.set(source.subarray(0,recordsOffset));
    const unshuffle=(offset,rows,width)=>{for(let c=0;c<width;c++)for(let r=0;r<rows;r++)out[offset+r*width+c]=source[offset+c*rows+r];};
    unshuffle(recordsOffset,n,stride);unshuffle(partsOffset,nr,16);unshuffle(pointsOffset,np,4);
    const delta=new Uint16Array(out.buffer,pointsOffset,np*2);let x=0,y=0;
    for(let k=0;k<np;k++){x=(x+delta[k*2])&65535;y=(y+delta[k*2+1])&65535;if(x>511||y>511)throw Error('Corrupt contour delta');delta[k*2]=x;delta[k*2+1]=y;}
    out.set([87,67,86,54],0);buffer=out.buffer;d=new DataView(buffer);
  }
  const fields=new Float64Array(buffer,fieldsOffset,nf*4),points=new Uint16Array(buffer,pointsOffset,np*2);
  const record=i=>{
    if(i<0||i>=n)throw Error('Cell index outside chunk');const o=recordsOffset+i*stride;
    return {id:d.getUint32(o,true),row:d.getInt32(o+4,true),field:d.getUint16(o+8,true),flags:d.getUint16(o+10,true),
      leaf:d.getUint8(o+12),cellstp:d.getUint8(o+13),nuclei:d.getUint8(o+14),matchKind:d.getUint8(o+15),
      x:d.getFloat32(o+16,true),y:d.getFloat32(o+20,true),
      features:new Float32Array(buffer,o+24,FEATURE_COUNT),p:new Float32Array(buffer,o+24+FEATURE_COUNT*4,6)};
  };
  const part=i=>{const o=partsOffset+i*16;return {cell:d.getUint32(o,true),start:d.getUint32(o+4,true),count:d.getUint32(o+8,true),kind:d.getUint8(o+12)};};
  // Closed rings become individual GPU line segments; no polygon/Canvas loop per frame.
  let nv=0;for(let i=0;i<nr;i++){const p=part(i);if(p.cell>=n||p.start+p.count>np||p.kind>3)throw Error('Invalid contour ring');nv+=p.count*2;}
  const xy=new Float32Array(nv*2),style=new Uint8Array(nv*4),values=new Float32Array(nv*3);
  let vertex=0;
  for(let i=0;i<nr;i++){
    const p=part(i),r=record(p.cell),f=r.field*4;
    if(r.field>=nf)throw Error('Invalid field transform');
    for(let k=0;k<p.count;k++)for(const t of [k,(k+1)%p.count]){
      const pt=(p.start+t)*2;
      xy[vertex*2]=fields[f]+points[pt]*fields[f+2];xy[vertex*2+1]=fields[f+1]+points[pt+1]*fields[f+3];
      style.set([r.leaf,r.cellstp,(r.flags&1)?1:0,p.kind],vertex*4);
      values.set([r.features[3]||0,Math.log2(Math.max(1,r.features[0])/32)/4,(r.features[8]||0)/10],vertex*3);vertex++;
    }
  }
  return {n,nr,np,nf,nv,record,part,fields,points,xy,style,values,buffer,
    bytes:buffer.byteLength+2*(xy.byteLength+style.byteLength+values.byteLength)};
}
export async function readCompressed(response){
  if(!response.ok)throw Error(`Whole-cell data unavailable (${response.status})`);
  let b=await response.arrayBuffer();const a=new Uint8Array(b);
  if(a[0]===31&&a[1]===139){if(typeof DecompressionStream==='undefined')throw Error('This browser needs gzip stream support');b=await new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();}
  return b;
}
