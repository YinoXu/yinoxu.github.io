// Frozen v15 point data: immutable commit URLs and byte-checked delivery parts.
const PINNED=/^https:\/\/raw\.githubusercontent\.com\/YinoXu\/yinoxu\.github\.io\/[a-f0-9]{40}\/points-v15\/$/;
export function validatePointBase(base){if(!PINNED.test(base))throw Error('Invalid v15 data revision');return base;}
async function digest(buffer){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),x=>x.toString(16).padStart(2,'0')).join('');}
export async function loadPointBinary(descriptor,base,signal){
  validatePointBase(base);const parts=descriptor.parts||[descriptor];
  const received=await Promise.all(parts.map(async part=>{
    if(!/^(S03|S07)\/[a-z0-9_./-]+$/.test(part.file)||part.file.includes('..')||!Number.isSafeInteger(part.bytes)||part.bytes<1||part.bytes>1800000)throw Error('Invalid v15 delivery descriptor');
    const response=await fetch(new URL(part.file,base),{signal});if(!response.ok)throw Error('NuClass v15 data unavailable ('+response.status+')');
    const data=await response.arrayBuffer();if(data.byteLength!==part.bytes||await digest(data)!==part.sha256)throw Error('NuClass v15 data integrity check failed');return new Uint8Array(data);
  }));
  const size=received.reduce((n,d)=>n+d.byteLength,0);if(size!==descriptor.bytes)throw Error('Incomplete v15 delivery');
  let data=new Uint8Array(size),offset=0;for(const part of received){data.set(part,offset);offset+=part.byteLength;}
  let buffer=data.buffer;
  if(descriptor.compression==='gzip'){
    if(data[0]!==31||data[1]!==139||typeof DecompressionStream==='undefined')throw Error('Gzip support is required for NuClass v15');
    buffer=await new Response(new Blob([data]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  if(descriptor.decoded_bytes!==undefined&&(buffer.byteLength!==descriptor.decoded_bytes||await digest(buffer)!==descriptor.decoded_sha256))throw Error('Incomplete decoded v15 data');
  if(signal?.aborted)throw new DOMException('Aborted','AbortError');return buffer;
}
export async function loadPointIndex(descriptor,base,signal){return JSON.parse(new TextDecoder().decode(await loadPointBinary(descriptor,base,signal)));}
