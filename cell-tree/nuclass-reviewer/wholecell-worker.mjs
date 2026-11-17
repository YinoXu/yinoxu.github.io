import {parseWholeCell} from './wholecell-format.mjs?v=4';
import {buildRenderGeometry} from './wholecell-geometry.mjs?v=5';
self.onmessage=({data:{id,epoch,buffer}})=>{try{
  const chunk=parseWholeCell(buffer,{expand:false}),geometry=buildRenderGeometry(chunk);
  self.postMessage({id,epoch,buffer:chunk.buffer,geometry},[chunk.buffer,geometry.lines,geometry.fills]);
}catch(error){self.postMessage({id,epoch,error:error.message});}};
