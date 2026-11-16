import {readCompressed} from './wholecell-format.mjs?v=4';

// Compressed bundles reduce request count. Only the selected shard is inflated.
// The contour cache and this8MiB compressed-bundle cache have separate budgets.
export function createShardReader(base){
  const cache=new Map(),pending=new Map();let epoch=0;const maxBytes=8*1024*1024,maxItems=8;
  function trim(){let bytes=[...cache.values()].reduce((sum,b)=>sum+b.byteLength,0);while(cache.size>maxItems||bytes>maxBytes){const key=cache.keys().next().value;bytes-=cache.get(key).byteLength;cache.delete(key);}}
  async function bundle(sid,c){
    const url=new URL(sid+'/'+c.bundle.file,base()).href;
    if(cache.has(url)){const data=cache.get(url);cache.delete(url);cache.set(url,data);return data;}
    if(pending.has(url))return pending.get(url).promise;
    const current=epoch,controller=new AbortController();
    const promise=fetch(url,{signal:controller.signal}).then(r=>{if(!r.ok)throw Error('Contour bundle unavailable ('+r.status+')');return r.arrayBuffer();}).then(async data=>{
      if(data.byteLength!==c.bundle.bytes||data.byteLength>2*1024*1024)throw Error('Invalid contour bundle length');
      const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data)),x=>x.toString(16).padStart(2,'0')).join('');
      if(digest!==c.bundle.sha256)throw Error('Contour bundle integrity check failed');
      if(current===epoch){cache.set(url,data);trim();}return data;
    }).finally(()=>{if(current===epoch)pending.delete(url);});
    pending.set(url,{promise,controller});return promise;
  }
  return {
    async read(sid,c,kind,signal){
      if(signal?.aborted)throw new DOMException('Aborted','AbortError');
      if(!c.bundle)return readCompressed(await fetch(new URL(sid+'/'+(kind==='geometry'?c.file:'posteriors/'+c.key+'.bin.gz'),base()),{signal}));
      const data=await bundle(sid,c);if(signal?.aborted)throw new DOMException('Aborted','AbortError');
      const offset=c.bundle[kind+'_offset'],bytes=c.bundle[kind+'_bytes'];
      if(!Number.isSafeInteger(offset)||!Number.isSafeInteger(bytes)||offset<0||bytes<1||offset+bytes>data.byteLength)throw Error('Invalid contour bundle index');
      return readCompressed(new Response(data.slice(offset,offset+bytes)));
    },
    clear(){epoch++;for(const p of pending.values())p.controller.abort();pending.clear();cache.clear();},
    get state(){return {items:cache.size,bytes:[...cache.values()].reduce((sum,b)=>sum+b.byteLength,0),pending:pending.size};}
  };
}
