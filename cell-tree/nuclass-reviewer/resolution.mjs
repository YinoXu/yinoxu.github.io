// Pure resolution logic shared by the background worker and regression tests.
export function makeResolutionTable(taxonomy) {
  const slots=Math.max(...taxonomy.paths.fine.map(p=>p.length));
  const paths=new Uint8Array(47*slots).fill(taxonomy.nodes.indexOf('All'));
  const starts={};
  taxonomy.paths.fine.forEach((path,li)=>path.forEach((node,j)=>{paths[li*slots+j]=taxonomy.nodes.indexOf(node);}));
  for(const mode of ['fine','lineage','broad'])starts[mode]=Uint8Array.from(taxonomy.paths[mode],(path,li)=>taxonomy.paths.fine[li].indexOf(path[0]));
  return {slots,paths,starts};
}
export function resolveCells(leaves,support,table,mode,step) {
  if(!table.starts[mode]||!Number.isInteger(step)||step<0||step>19)throw Error('Invalid resolution settings');
  if(step&&(!support||support.length!==leaves.length*table.slots))throw Error('Support data unavailable');
  const result=new Uint8Array(leaves.length),{slots,paths}=table,start=table.starts[mode];
  for(let i=0;i<leaves.length;i++){
    const li=leaves[i];let j=start[li];
    while(step&&j<slots-1&&support[i*slots+j]<step)j++;
    result[i]=paths[li*slots+j];
  }
  return result;
}
