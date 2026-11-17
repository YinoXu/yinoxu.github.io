import {makeResolutionTable,resolveCells} from './resolution.mjs';
import {loadPointBinary} from './point-data.mjs?v=1';
let leaves,support,table;
self.onmessage=async({data})=>{
  try{
    if(data.type==='init'){
      leaves=new Uint8Array(data.leaves);table=makeResolutionTable(data.taxonomy);
      let buffer;
      if(data.descriptor)buffer=await loadPointBinary(data.descriptor,data.base);
      else{const response=await fetch(data.url);if(!response.ok)throw Error(`Support data request failed (${response.status})`);buffer=await response.arrayBuffer();}
      const magic=new Uint8Array(buffer);
      if(magic[0]===31&&magic[1]===139)buffer=await new Response(new Blob([buffer]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
      const header=new DataView(buffer);
      if(header.getUint32(0,true)!==leaves.length||header.getUint32(4,true)!==table.slots||buffer.byteLength!==8+leaves.length*table.slots)throw Error('Incomplete support data');
      support=new Uint8Array(buffer,8);self.postMessage({type:'ready'});
    }else if(data.type==='resolve'){
      const labels=resolveCells(leaves,support,table,data.mode,data.step);
      self.postMessage({type:'labels',version:data.version,mode:data.mode,step:data.step,buffer:labels.buffer},[labels.buffer]);
    }
  }catch(error){self.postMessage({type:'error',message:error.message});}
};
