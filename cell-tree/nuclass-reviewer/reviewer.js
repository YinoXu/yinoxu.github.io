import {makeResolutionTable,resolveCells} from './resolution.mjs';
import {createWholeCellViewer} from './wholecell.mjs?v=6';
import {loadPointBinary,loadPointIndex,validatePointBase} from './point-data.mjs?v=1';
import {createShardReader} from './wholecell-shards.mjs?v=4';
const $ = id => document.getElementById(id);
const fmt = n => n.toLocaleString('en-US');
const S = {slide:'S07', mode:'fine', step:0, appliedMode:'fine', appliedStep:0, labels:null, supportReady:false, resolving:false, selected:new Set(Array.from({length:47},(_,i)=>i)), meta:null, data:null,
  cx:0, cy:0, scale:1, w:1, h:1, dpr:1, fit:true, split:true, show:true, clean:false, held:false,
  radius:1.6, opacity:.85, he:.6, marks:'dot', ready:false, cell:null, epoch:0,analysisMode:'types',layers:new Set(['types'])};
if(!$('tlscells')){const layer=document.createElement('canvas');layer.id='tlscells';layer.setAttribute('aria-hidden','true');$('wholecells').after(layer);}
if(!$('wholecell-atlas')){const layer=document.createElement('canvas');layer.id='wholecell-atlas';layer.setAttribute('aria-hidden','true');$('wholecells').before(layer);}
const surfaces = ['original','tissue','cells','wholecell-atlas','wholecells','tlscells','selection'].map($);
const original = $('original').getContext('2d'), tissue = $('tissue').getContext('2d');
const selection = $('selection').getContext('2d'), mini = $('minimap').getContext('2d');
let manifest, taxonomy, frame=0, settleTimer=0, abortSlide, tiles = new Map(), queue=[], activeTiles=0;
let wanted = new Set(), overview, initialOverlay, loadMessage='', loadError=false, selectedEpoch=0, visible=[];
const probabilities = new Map();
let resolver, resolutionTable, resolutionVersion=0, resolverBusy=false;
const gl = $('cells').getContext('webgl', {alpha:true,antialias:false,premultipliedAlpha:false,preserveDrawingBuffer:false});
let gpu, fallback;
let wholeCell;
let pointReader;
if (!gl) fallback = $('cells').getContext('2d');

function shader(type, source) {
  const shader = gl.createShader(type); gl.shaderSource(shader,source); gl.compileShader(shader);
  if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
  return shader;
}
function initGPU() {
  if(!gl) return;
  const p=gl.createProgram();
  gl.attachShader(p,shader(gl.VERTEX_SHADER,`
    precision highp float;
    attribute vec2 a_position; attribute float a_leaf; attribute float a_node;
    uniform vec2 u_center; uniform vec2 u_view; uniform float u_scale; uniform float u_size;
    uniform vec3 u_colors[${taxonomy.nodes.length}]; uniform float u_enabled[47]; varying vec3 v_color;
    void main(){int i=int(a_leaf); vec2 xy=(a_position-u_center)*u_scale/u_view*2.0;
      gl_Position=vec4(xy.x,-xy.y,0.0,1.0);
      if(u_enabled[i]<0.5)gl_Position=vec4(3.0,3.0,0.0,1.0);
      gl_PointSize=u_size;v_color=u_colors[int(a_node)];}`));
  gl.attachShader(p,shader(gl.FRAGMENT_SHADER,`
    precision mediump float; varying vec3 v_color; uniform float u_opacity; uniform float u_ring;
    void main(){float d=length(gl_PointCoord-vec2(0.5));if(d>0.5)discard;
      if(u_ring>0.5&&d<0.30)discard; gl_FragColor=vec4(v_color,u_opacity);}`));
  gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw new Error(gl.getProgramInfoLog(p));
  gl.useProgram(p);gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  gpu={p,xy:gl.createBuffer(),leaf:gl.createBuffer(),node:gl.createBuffer(),u:{}};
  for(const n of ['center','view','scale','size','colors','enabled','opacity','ring'])gpu.u[n]=gl.getUniformLocation(p,'u_'+n);
  gpu.position=gl.getAttribLocation(p,'a_position');gpu.type=gl.getAttribLocation(p,'a_leaf');gpu.nodeType=gl.getAttribLocation(p,'a_node');
  if(S.data)uploadCells();
}
function uploadCells(){
  if(!gpu)return;
  gl.bindBuffer(gl.ARRAY_BUFFER,gpu.xy);gl.bufferData(gl.ARRAY_BUFFER,S.data.xy,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(gpu.position);gl.vertexAttribPointer(gpu.position,2,gl.FLOAT,false,0,0);
  gl.bindBuffer(gl.ARRAY_BUFFER,gpu.leaf);gl.bufferData(gl.ARRAY_BUFFER,S.data.leaf,gl.STATIC_DRAW);
  gl.enableVertexAttribArray(gpu.type);gl.vertexAttribPointer(gpu.type,1,gl.UNSIGNED_BYTE,false,0,0);
  uploadLabels();updatePalette();
}
function uploadLabels(){if(!gpu||!S.labels)return;gl.bindBuffer(gl.ARRAY_BUFFER,gpu.node);gl.bufferData(gl.ARRAY_BUFFER,S.labels,gl.DYNAMIC_DRAW);gl.enableVertexAttribArray(gpu.nodeType);gl.vertexAttribPointer(gpu.nodeType,1,gl.UNSIGNED_BYTE,false,0,0);}
function nodeForCell(i){return taxonomy.nodes[S.labels[i]];}
function label(node){return taxonomy.labels[node]||node;}
function color(node){return taxonomy.colors[node]||'#a8adb4';}
function updatePalette(){
  if(!taxonomy||!gpu)return;
  const rgb=taxonomy.nodes.flatMap(node=>color(node).slice(1).match(/../g).map(x=>parseInt(x,16)/255));
  gl.useProgram(gpu.p);gl.uniform3fv(gpu.u.colors,new Float32Array(rgb));
  gl.uniform1fv(gpu.u.enabled,new Float32Array(taxonomy.leaves.map((_,i)=>S.selected.has(i)?1:0)));
}
function updateSelectedInfo(){if(S.cell){$('cell-info').innerHTML=`<h3 class="cell-name">${label(taxonomy.leaves[S.cell.leaf])}</h3><div class="cell-meta">NuClass v15 · step59712<br>${S.slide} · x ${fmt(S.cell.x)} · y ${fmt(S.cell.y)}<br>Displayed as ${label(nodeForCell(S.cell.i))}<br>Posterior support ≥ ${ (S.appliedStep/20).toFixed(2)}</div>`;}}
function applyLabels(labels,mode,step){
  S.labels=labels;S.appliedMode=mode;S.appliedStep=step;S.resolving=false;
  uploadLabels();updateSelectedInfo();$('export').disabled=!S.ready;
  $('support-status').textContent=step===0?'Full detail · no support cutoff':'Uncertain labels roll up · no cells removed';
  changed();
}
function supportError(message){resolverBusy=false;S.supportReady=false;S.resolving=false;$('support').disabled=true;$('retry-support').hidden=false;$('support-status').textContent=message+' Current overlay retained.';$('export').disabled=!S.ready;}
function startResolver(){
  if(!S.data)return;resolver?.terminate();resolverBusy=false;S.supportReady=false;S.resolving=S.appliedMode!==S.mode||S.appliedStep!==S.step;$('export').disabled=!S.ready||S.resolving;
  $('support').disabled=true;$('retry-support').hidden=true;$('support-status').textContent='Loading posterior controls…';
  const epoch=S.epoch;
  try{
    resolver=new Worker(new URL('./resolution-worker.js?v=15',import.meta.url),{type:'module'});const owner=resolver;
    resolver.onmessage=({data})=>{
      if(epoch!==S.epoch||resolver!==owner)return;
      if(data.type==='ready'){S.supportReady=true;$('support').disabled=false;requestResolution();}
      else if(data.type==='labels'){
        resolverBusy=false;
        if(data.version===resolutionVersion)applyLabels(new Uint8Array(data.buffer),data.mode,data.step);
        else dispatchResolution();
      }else supportError('Posterior data could not load.');
    };
    resolver.onerror=()=>{if(epoch===S.epoch&&resolver===owner)supportError('Posterior controls could not start.');};
    const leaves=S.data.leaf.slice();resolver.postMessage({type:'init',leaves:leaves.buffer,taxonomy,descriptor:S.meta.point_support,base:manifest.point_base},[leaves.buffer]);
  }catch{supportError('Posterior controls could not start.');}
}
function dispatchResolution(){
  if(!S.data||!S.supportReady||resolverBusy)return;
  resolverBusy=true;resolver.postMessage({type:'resolve',mode:S.mode,step:S.step,version:resolutionVersion});
}
function requestResolution(){
  resolutionVersion++;$('support-value').textContent=(S.step/20).toFixed(2);$('support').value=S.step/20;
  if(!S.data)return;
  if(!S.supportReady&&S.step===0){applyLabels(resolveCells(S.data.leaf,null,resolutionTable,S.mode,0),S.mode,0);return;}
  S.resolving=true;$('export').disabled=true;$('support-status').textContent=S.supportReady?'Updating labels…':'Loading posterior controls…';
  dispatchResolution();
}
function setThreshold(value){S.step=Math.max(0,Math.min(19,Math.round(Number(value)*20)));requestResolution();}
function request(){if(!frame)frame=requestAnimationFrame(()=>{frame=0;draw();});}
function settle(){clearTimeout(settleTimer);settleTimer=setTimeout(updateStatistics,180);}
function changed(){request();settle();}
function point(x,y){return[(x-S.cx)*S.scale+S.w/2,(y-S.cy)*S.scale+S.h/2];}
function world(x,y){return[S.cx+(x-S.w/2)/S.scale,S.cy+(y-S.h/2)/S.scale];}
function bounds(){return[S.cx-S.w/2/S.scale,S.cy-S.h/2/S.scale,S.cx+S.w/2/S.scale,S.cy+S.h/2/S.scale];}
function fit(){if(!S.meta)return;S.fit=true;S.cx=S.meta.width/2;S.cy=S.meta.height/2;S.scale=Math.min(S.w/S.meta.width,S.h/S.meta.height)*.94;changed();}
function clampCenter(){if(!S.meta)return;const marginX=S.w/S.scale*.35,marginY=S.h/S.scale*.35;S.cx=Math.max(-marginX,Math.min(S.meta.width+marginX,S.cx));S.cy=Math.max(-marginY,Math.min(S.meta.height+marginY,S.cy));}
function zoom(f,x=S.w/2,y=S.h/2){if(!S.meta)return;S.fit=false;const p=world(x,y),min=Math.min(S.w/S.meta.width,S.h/S.meta.height)*.18;S.scale=Math.max(min,Math.min(12,S.scale*f));S.cx=p[0]-(x-S.w/2)/S.scale;S.cy=p[1]-(y-S.h/2)/S.scale;clampCenter();changed();}
function physical(um){if(!S.meta)return;S.fit=false;S.scale=S.w*S.meta.mpp[0]/um;changed();}
function resize(){
  const r=$('overlay-pane').getBoundingClientRect();S.w=Math.max(1,r.width);S.h=Math.max(1,r.height);S.dpr=Math.min(devicePixelRatio||1,2);
  for(const c of surfaces){const w=Math.round(S.w*S.dpr),h=Math.round(S.h*S.dpr);if(c.width!==w||c.height!==h){c.width=w;c.height=h;}}
  if(S.fit)fit();else changed();
}
async function json(path,signal){const r=await fetch(path,{signal});if(!r.ok)throw Error(`Could not load ${path} (${r.status})`);return r.json();}
async function binary(path,signal){
  const r=await fetch(path,{signal});if(!r.ok)throw Error(`Data request failed (${r.status})`);
  const b=await r.arrayBuffer(),u=new Uint8Array(b);
  if(u[0]===31&&u[1]===139){if(!globalThis.DecompressionStream)throw Error('Please use a current browser to load the cell data.');return new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();}
  return b;
}
function status(message,error=false){loadMessage=message;loadError=error;$('status').textContent=message;document.querySelector('.stage-footer').classList.toggle('error',error);$('retry').hidden=!error;}
function makeImage(src,onload){const im=new Image();im.onload=()=>{onload?.();request();};im.src=src;return im;}
async function selectSlide(id){
  if(!manifest.slides.some(x=>x.id===id))return;
  abortSlide?.abort();abortSlide=new AbortController();const signal=abortSlide.signal,epoch=++S.epoch;
  resolver?.terminate();resolverBusy=false;resolutionVersion++;S.supportReady=false;S.resolving=false;S.labels=null;$('support').disabled=true;$('retry-support').hidden=true;$('support-status').textContent='Loading posterior controls…';
  selectedEpoch++;S.slide=id;S.meta=null;S.data=null;S.ready=false;S.cell=null;S.fit=true;visible=[];probabilities.clear();
  pointReader?.clear();
  wholeCell?.setSlide(id);
  tiles.clear();queue=[];$('sample').value=id;$('mobile-sample').textContent=id;$('export').disabled=true;
  $('cell-info').innerHTML='<p class="subtle">Zoom into the tissue and click a nucleus to inspect its predicted type and 47-class posterior.</p>';$('probabilities').replaceChildren();$('export-cell').hidden=true;
  $('legend').textContent='Loading cell map…';$('visible-count').textContent='';$('field').value='whole';
  status(`Loading ${id} tissue…`);request();renderFilters();
  try{
    const meta=await loadPointIndex(manifest.remote_indexes[id],manifest.point_base,signal);if(epoch!==S.epoch)return;S.meta=meta;
    if(meta.point_model?.name!=='NuClass v15'||meta.point_model.sha256!==manifest.provenance.sourceModel.sha256)throw Error('Cell-type model revision mismatch');
    S.meta.chunkMap=new Map(S.meta.chunks.map(c=>[c.key,c]));
    overview=makeImage(`data/${id}/overview.jpg`,()=>{if(epoch===S.epoch)drawMini();});
    initialOverlay=makeImage(`data/${id}/overlay-v15.webp?v=${manifest.data_revision}`);
    $('field').innerHTML='<option value="whole">Whole slide</option>'+S.meta.fields.map(f=>`<option value="${f.id}">${f.label}</option>`).join('');fit();
    status(`Loading ${fmt(S.meta.valid)} cells · preview available`);
    const buffer=await loadPointBinary(S.meta.point_cells,manifest.point_base,signal);if(epoch!==S.epoch)return;
    const n=new DataView(buffer).getUint32(0,true);if(n!==S.meta.valid||buffer.byteLength!==4+n*9)throw Error('Cell data integrity check failed.');
    S.data={n,xy:new Float32Array(buffer,4,n*2),leaf:new Uint8Array(buffer,4+n*8,n)};S.labels=resolveCells(S.data.leaf,null,resolutionTable,S.mode,0);S.appliedMode=S.mode;S.appliedStep=0;uploadCells();S.ready=true;startResolver();
    status(`${fmt(n)} cells · all zoom levels`);$('export').disabled=S.resolving;changed();updateStatistics();
    const url=new URL(location.href);url.searchParams.set('slide',id);history.replaceState(null,'',url);
  }catch(e){if(e.name==='AbortError')return;status(e.message+' · Retry to reload.',true);console.error(e);}
}

// Only visible image tiles enter the queue. The overview and cached ancestors
// remain on screen while a sharper level arrives. Decoded images have an LRU cap.
function tileURL(level,x,y){return `data/${S.slide}/tiles/${level}/${x}_${y}.${S.meta.tile_ext}`;}
function tile(url){
  wanted.add(url);let t=tiles.get(url);
  if(!t){t={url,used:performance.now(),image:null,state:'queued',epoch:S.epoch,attempts:0};tiles.set(url,t);queue.push(t);}
  t.used=performance.now();return t.image;
}
function pumpTiles(){
  queue=queue.filter(t=>t.epoch===S.epoch&&wanted.has(t.url));
  for(const [key,t]of tiles)if(t.state==='queued'&&!wanted.has(key))tiles.delete(key);
  while(activeTiles<6&&queue.length){
    const t=queue.shift();if(t.state!=='queued')continue;t.state='loading';t.attempts++;activeTiles++;
    const im=new Image();im.decoding='async';
    im.onload=async()=>{try{await im.decode();}catch{}t.image=im;t.state='ready';activeTiles--;if(t.epoch===S.epoch)request();pumpTiles();};
    im.onerror=()=>{t.state='error';activeTiles--;if(t.epoch===S.epoch){request();if(t.attempts<3)setTimeout(()=>{if(t.epoch===S.epoch&&wanted.has(t.url)&&t.state==='error'){t.state='queued';queue.push(t);pumpTiles();}},800*t.attempts);}pumpTiles();};
    im.src=t.url;
  }
  const old=[...tiles.values()].filter(t=>t.state!=='loading'&&!wanted.has(t.url)).sort((a,b)=>a.used-b.used);
  while(tiles.size>80&&old.length){const t=old.shift();t.image=null;tiles.delete(t.url);}
}
function reset2d(c){c.setTransform(S.dpr,0,0,S.dpr,0,0);c.clearRect(0,0,S.w,S.h);}
function drawBase(c,b,level){
  reset2d(c);c.fillStyle='#eeedea';c.fillRect(0,0,S.w,S.h);const q=point(0,0),m=S.meta;
  if(overview?.complete&&overview.naturalWidth)c.drawImage(overview,...q,m.width*S.scale,m.height*S.scale);
  // Cached coarse tiles prevent the image from dropping back to the thumbnail.
  for(let l=Math.min(level+3,m.levels.length-1);l>=level;l--){
    const ds=2**l,step=m.tile_size*ds,L=m.levels[l],coords=[];
    for(let y=Math.max(0,Math.floor(b[1]/step));y<=Math.min(Math.ceil(L.height/m.tile_size)-1,Math.floor(b[3]/step));y++)
      for(let x=Math.max(0,Math.floor(b[0]/step));x<=Math.min(Math.ceil(L.width/m.tile_size)-1,Math.floor(b[2]/step));x++)coords.push([x,y]);
    coords.sort((a,z)=>Math.hypot(a[0]*step-S.cx,a[1]*step-S.cy)-Math.hypot(z[0]*step-S.cx,z[1]*step-S.cy));
    for(const [x,y]of coords){const url=tileURL(l,x,y),im=l===level?tile(url):tiles.get(url)?.image;if(!im)continue;const p=point(x*step,y*step);c.drawImage(im,...p,im.naturalWidth*ds*S.scale+.2,im.naturalHeight*ds*S.scale+.2);}
  }
}
function drawCells(){
  const show=S.layers.has('types')&&S.show&&!S.clean&&!S.held&&S.ready;
  if(gl&&gpu){
    gl.viewport(0,0,$('cells').width,$('cells').height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);if(!show)return;
    const u=gpu.u;gl.useProgram(gpu.p);gl.uniform2f(u.center,S.cx,S.cy);gl.uniform2f(u.view,S.w,S.h);gl.uniform1f(u.scale,S.scale);
    gl.uniform1f(u.size,Math.max(.65,Math.min(5,S.radius*Math.sqrt(Math.max(.2,S.scale/.12))))*2*S.dpr);
    gl.uniform1f(u.opacity,S.opacity);gl.uniform1f(u.ring,S.marks==='ring'&&S.scale>.05?1:0);
    // Spatial chunks are contiguous in the immutable point buffer. Clip whole
    // ranges before vertex processing while retaining every visible point.
    const margin=8/S.scale,b=bounds().map((v,i)=>v+(i<2?-margin:margin)),chunks=viewportChunks(b);
    if(chunks.length>700||S.debugFullPoints){gl.drawArrays(gl.POINTS,0,S.data.n);}
    else{let start=-1,end=-1;for(const c of chunks){if(c.start===end){end+=c.count;continue;}if(start>=0)gl.drawArrays(gl.POINTS,start,end-start);start=c.start;end=c.start+c.count;}if(start>=0)gl.drawArrays(gl.POINTS,start,end-start);}
  }else if(fallback){
    reset2d(fallback);if(!show)return;
    // Canvas fallback retains every cell; no zoom cutoff or subsampling.
    const b=bounds(),r=Math.max(.65,Math.min(5,S.radius*Math.sqrt(Math.max(.2,S.scale/.12))));fallback.globalAlpha=S.opacity;
    for(const chunk of viewportChunks(b))for(let i=chunk.start;i<chunk.start+chunk.count;i++){
      const x=S.data.xy[i*2],y=S.data.xy[i*2+1],li=S.data.leaf[i];if(!S.selected.has(li)||x<b[0]||x>b[2]||y<b[1]||y>b[3])continue;
      const p=point(x,y);fallback.fillStyle=color(nodeForCell(i));fallback.fillRect(p[0]-r,p[1]-r,r*2,r*2);
    }fallback.globalAlpha=1;
  }
}
function draw(){
  const started=performance.now();
  if(!S.meta){for(const c of[original,tissue,selection])reset2d(c);if(gl)gl.clear(gl.COLOR_BUFFER_BIT);wholeCell?.draw(null);return;}
  const b=bounds(),level=Math.max(0,Math.min(S.meta.levels.length-1,Math.floor(Math.log2(1/(S.scale*S.dpr)))));wanted=new Set();
  $('reviewer').dataset.imageLevel=level;
  drawBase(tissue,b,level);if(S.split)drawBase(original,b,level);
  if(S.layers.size&&!S.clean&&!S.held){
    tissue.fillStyle=`rgba(255,255,255,${1-S.he})`;tissue.fillRect(0,0,S.w,S.h);
    if(S.layers.has('types')&&S.show&&!S.ready&&S.mode==='fine'&&S.selected.size===47&&initialOverlay?.complete&&initialOverlay.naturalWidth){const q=point(0,0);tissue.globalAlpha=S.opacity;tissue.drawImage(initialOverlay,...q,S.meta.width*S.scale,S.meta.height*S.scale);tissue.globalAlpha=1;}
  }
  drawCells();wholeCell?.draw(b);reset2d(selection);
  const selectionContexts=S.split?[selection,original]:[selection];
  const hasBoundary=wholeCell?.drawSelection(selectionContexts);
  if(!hasBoundary&&S.cell&&S.layers.has('types')&&!S.clean&&!S.held){const p=point(S.cell.x,S.cell.y);for(const c of selectionContexts){c.beginPath();c.moveTo(p[0]-5,p[1]);c.lineTo(p[0]+5,p[1]);c.moveTo(p[0],p[1]-5);c.lineTo(p[0],p[1]+5);c.strokeStyle='#fff';c.lineWidth=4;c.stroke();c.strokeStyle='#087b91';c.lineWidth=2;c.stroke();}}
  pumpTiles();drawMini();
  const fov=S.w*S.meta.mpp[0]/S.scale,um=[10,20,50,100,200,500,1000,2000,5000,10000].filter(v=>v<fov*.22).pop()||10;
  $('scale-label').textContent=um>=1000?`${um/1000} mm`:`${um} μm`;$('scale-line').style.width=`${um/S.meta.mpp[0]*S.scale}px`;
  const badges=[];
  if(S.layers.has('types'))badges.push(`NUCLASS v15 · ${S.appliedMode.toUpperCase()}`);
  if(S.layers.has('wholecell'))badges.push('WHOLE CELL v6 · '+['v15 TYPES','PREVIOUS TYPES','N:C','CELL AREA','NUCLEAR DISPLACEMENT'][+$('wc-colour').value]);
  if(S.layers.has('tls'))badges.push('TLS · '+($('wc-tls-colour').value==='stage'?'SCIENCE PREDICTION':'COMPOSITION'));
  $('overlay-badge').textContent=S.clean||S.held||!badges.length?'ORIGINAL H&E':badges.join(' + ');
  $('view-size').textContent=`${fov>=1000?(fov/1000).toFixed(1)+' mm':Math.round(fov)+' μm'} field`;
  if(new URLSearchParams(location.search).has('debug')){const d=$('reviewer').dataset;d.drawMs=(performance.now()-started).toFixed(2);d.cells=S.data?.n||0;d.cache=tiles.size;d.renderer=gl?'WebGL':'Canvas2D';}
}
function drawMini(){
  const c=$('minimap'),m=S.meta;if(!m)return;mini.clearRect(0,0,c.width,c.height);mini.fillStyle='#f1f0ed';mini.fillRect(0,0,c.width,c.height);
  const scale=Math.min(c.width/m.width,c.height/m.height),x=(c.width-m.width*scale)/2,y=(c.height-m.height*scale)/2;
  S.mini={x,y,scale};if(overview?.complete&&overview.naturalWidth)mini.drawImage(overview,x,y,m.width*scale,m.height*scale);
  const b=bounds();mini.strokeStyle='#315d89';mini.lineWidth=2;mini.fillStyle='#315d8910';mini.fillRect(x+b[0]*scale,y+b[1]*scale,(b[2]-b[0])*scale,(b[3]-b[1])*scale);mini.strokeRect(x+b[0]*scale,y+b[1]*scale,(b[2]-b[0])*scale,(b[3]-b[1])*scale);
}
function viewportChunks(b){
  const list=[],size=S.meta.cell_chunk_px;
  for(let y=Math.max(0,Math.floor(b[1]/size));y<=Math.floor(Math.min(S.meta.height-1,b[3])/size);y++)for(let x=Math.max(0,Math.floor(b[0]/size));x<=Math.floor(Math.min(S.meta.width-1,b[2])/size);x++){const c=S.meta.chunkMap.get(`${x}_${y}`);if(c)list.push(c);}return list;
}
function updateStatistics(){
  if(!S.ready)return;const b=bounds(),counts=new Map();let total=0;
  for(const c of viewportChunks(b))for(let i=c.start;i<c.start+c.count;i++){
    const x=S.data.xy[i*2],y=S.data.xy[i*2+1],leaf=S.data.leaf[i];if(x<b[0]||x>b[2]||y<b[1]||y>b[3]||!S.selected.has(leaf))continue;
    const node=nodeForCell(i);counts.set(node,(counts.get(node)||0)+1);total++;
  }
  $('legend').innerHTML=counts.size?[...counts].sort((a,b)=>b[1]-a[1]).map(([n,c])=>`<div class="legend-row"><i class="swatch" style="background:${color(n)}"></i><span>${label(n)}</span><span class="count">${fmt(c)}</span></div>`).join(''):'<div class="empty">No selected cells in this view.</div>';
  $('visible-count').textContent=fmt(total);
  if(!loadError)status(`${S.layers.has('types')?fmt(total)+' visible NuClass v15 nuclei · ':''}${S.layers.has('wholecell')?'v6 whole-cell boundaries · ':''}${S.layers.has('tls')?'TLS candidates · ':''}${S.layers.size?'layers can be combined':'clean H&E'}`);
}
function renderFilters(){
  if(!taxonomy)return;const counts=manifest.slides.find(s=>s.id===S.slide).counts,search=$('search').value.toLowerCase();
  $('filters').innerHTML=taxonomy.leaves.map((n,i)=>({n,i})).filter(({n})=>(label(n)+' '+n).toLowerCase().includes(search)).map(({n,i})=>`<label class="type-row ${S.selected.has(i)?'':'off'}"><input type="checkbox" data-leaf="${i}" ${S.selected.has(i)?'checked':''}><i class="swatch" style="background:${color(n)}"></i><span>${label(n)}</span><span class="count">${fmt(counts[i])}</span></label>`).join('');
  $('selected-count').textContent=`${S.selected.size} / 47`;
  document.querySelectorAll('[data-preset]').forEach(b=>{const p=b.dataset.preset,indices=p==='all'?taxonomy.leaves.map((_,i)=>i):p==='none'?[]:taxonomy.members[p==='epithelial'?'Epithelial':'Immune'];b.classList.toggle('active',indices.length===S.selected.size&&indices.every(i=>S.selected.has(i)));});
}
function clearExcludedSelection(){if(S.cell&&!S.selected.has(S.cell.leaf)){wholeCell?.clearSelection();S.cell=null;selectedEpoch++;$('cell-info').innerHTML='<p class="subtle">Click a visible nucleus to inspect its predicted type and posterior.</p>';$('probabilities').replaceChildren();$('export-cell').hidden=true;}}
function setPreset(preset){S.selected=new Set(preset==='all'?taxonomy.leaves.map((_,i)=>i):preset==='none'?[]:taxonomy.members[preset==='epithelial'?'Epithelial':'Immune']);clearExcludedSelection();renderFilters();updatePalette();changed();}
function setResolution(mode){if(!['fine','lineage','broad'].includes(mode))return;S.mode=mode;$('resolution').value=mode;requestResolution();}

async function selectAt(px,py){
  if(!S.ready)return;
  const clickSlideEpoch=S.epoch;
  const [wx,wy]=world(px,py),radius=12/S.scale,b=[wx-radius,wy-radius,wx+radius,wy+radius];let best=null,dist=radius*radius;
  if(S.layers.size===1&&S.layers.has('tls')){wholeCell?.pickRegion(wx,wy);return;}
  if(S.w*S.meta.mpp[0]/S.scale>2500){zoom(2,px,py);return;}
  const pickedWhole=S.layers.has('wholecell')?await wholeCell?.selectAt(wx,wy):null;if(clickSlideEpoch!==S.epoch)return;
  if(pickedWhole){selectedEpoch++;S.cell=null;request();if(innerWidth<=800){$('settings-panel').classList.add('open');$('toggle-settings').setAttribute('aria-expanded','true');}return;}
  if(!S.layers.has('types')){if(S.layers.has('tls'))wholeCell?.pickRegion(wx,wy);return;}
  for(const c of viewportChunks(b))for(let i=c.start;i<c.start+c.count;i++){
    if(!S.selected.has(S.data.leaf[i]))continue;const x=S.data.xy[i*2],y=S.data.xy[i*2+1],d=(x-wx)**2+(y-wy)**2;
    if(d<dist){dist=d;best={i,x,y,leaf:S.data.leaf[i],chunk:c};}
  }
  if(!best)return;const epoch=++selectedEpoch,sid=S.slide;wholeCell?.clearSelection();S.cell=best;request();
  wholeCell?.selectAt(best.x,best.y,{nuclear:true});
  updateSelectedInfo();
  $('probabilities').textContent='Loading 47-class posterior…';$('export-cell').hidden=true;
  if(innerWidth<=800){$('settings-panel').classList.add('open');$('toggle-settings').setAttribute('aria-expanded','true');}
  try{
    let data=probabilities.get(best.chunk.key);
    if(!data){data=new Uint16Array(await pointReader.read(sid,best.chunk,'posterior',abortSlide.signal));if(sid!==S.slide)return;if(data.length!==best.chunk.count*47)throw Error('Incomplete v15 posterior data.');probabilities.set(best.chunk.key,data);if(probabilities.size>12)probabilities.delete(probabilities.keys().next().value);}
    if(epoch!==selectedEpoch)return;const offset=(best.i-best.chunk.start)*47;best.p=Array.from(data.subarray(offset,offset+47),v=>v/65535);
    const rows=taxonomy.leaves.map((n,i)=>({n,p:best.p[i]})).sort((a,b)=>b.p-a.p);
    $('probabilities').innerHTML=rows.map(({n,p})=>`<div class="prob-row"><span>${label(n)}</span><span>${(p*100).toFixed(2)}%</span><i style="width:${p*100}%;background:${color(n)}"></i></div>`).join('');$('export-cell').hidden=false;
  }catch(e){if(e.name==='AbortError'||epoch!==selectedEpoch)return;$('probabilities').innerHTML='<span>Posterior could not load. </span><button id="retry-cell">Retry</button>';$('retry-cell').onclick=()=>selectAt(...point(best.x,best.y));}
}
function download(name,rows){const quote=v=>'"'+String(v).replaceAll('"','""')+'"';const blob=new Blob([rows.map(r=>r.map(quote).join(',')).join('\n')+'\n'],{type:'text/csv'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function exportView(){
  if(!S.ready||S.resolving)return;
  const epoch=S.epoch,b=bounds(),chunks=viewportChunks(b),mode=S.appliedMode,step=S.appliedStep,labels=S.labels,sid=S.slide,chosen=new Set(S.selected),data=S.data;
  const parts=['slide,native_x,native_y,leaf_prediction,displayed_label,posterior_support,model,step\n'];
  $('export').disabled=true;$('export').textContent='Exporting…';
  try{
    let k=0;
    for(const c of chunks){
      if(epoch!==S.epoch)return;
      let text='';
      for(let i=c.start;i<c.start+c.count;i++){
        const x=data.xy[i*2],y=data.xy[i*2+1],li=data.leaf[i];
        if(chosen.has(li)&&x>=b[0]&&x<=b[2]&&y>=b[1]&&y<=b[3])text+=`${sid},${x},${y},${taxonomy.leaves[li]},${taxonomy.nodes[labels[i]]},${(step/20).toFixed(2)},NuClass v15,59712\n`;
      }
      if(text)parts.push(new TextEncoder().encode(text));
      if(++k%32===0)await new Promise(r=>setTimeout(r,0));
    }
    const url=URL.createObjectURL(new Blob(parts,{type:'text/csv'})),a=document.createElement('a');a.href=url;a.download=`NuClass_v15_${sid}_${mode}_p${(step/20).toFixed(2)}_visible.csv`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }finally{$('export').disabled=!S.ready||S.resolving;$('export').textContent='Export view';}
}
function openField(id){const f=S.meta?.fields.find(f=>f.id===id);if(!f){fit();return;}S.fit=false;S.cx=f.origin[0]+f.width/2;S.cy=f.origin[1]+f.height/2;S.scale=Math.min(S.w/f.width,S.h/f.height)*.94;changed();}
function wire(){
  $('sample').onchange=e=>selectSlide(e.target.value);$('retry').onclick=()=>selectSlide(S.slide);$('resolution').onchange=e=>setResolution(e.target.value);$('field').onchange=e=>openField(e.target.value);$('support').oninput=e=>setThreshold(e.target.value);$('retry-support').onclick=startResolver;
  $('fit').onclick=()=>{$('field').value='whole';fit();};$('plus').onclick=()=>zoom(1.5);$('minus').onclick=()=>zoom(1/1.5);$('native').onclick=()=>{S.fit=false;S.scale=1;changed();};
  document.querySelectorAll('[data-fov]').forEach(b=>b.onclick=()=>physical(+b.dataset.fov));
  $('split').onclick=()=>{S.split=!S.split;$('panes').classList.toggle('single',!S.split);$('split').setAttribute('aria-pressed',S.split);resize();};
  $('fullscreen').onclick=async()=>{try{if(document.fullscreenElement)await document.exitFullscreen();else await $('reviewer').requestFullscreen();}catch{window.open(`index.html?slide=${S.slide}`,'_blank','noopener');}};
  document.addEventListener('fullscreenchange',()=>{$('fullscreen').textContent=document.fullscreenElement?'Exit fullscreen':'Fullscreen';resize();});
  $('show-cells').onchange=e=>{S.show=e.target.checked;changed();};$('marks').onchange=e=>{S.marks=e.target.value;request();};
  for(const [id,key]of [['size','radius'],['opacity','opacity'],['he-strength','he']])$(id).oninput=e=>{S[key]=+e.target.value;request();};
  $('clean').onclick=()=>{S.clean=!S.clean;$('clean').setAttribute('aria-pressed',S.clean);request();};$('search').oninput=renderFilters;
  document.querySelectorAll('[data-preset]').forEach(b=>b.onclick=()=>setPreset(b.dataset.preset));
  $('filters').onchange=e=>{if(e.target.dataset.leaf===undefined)return;const i=+e.target.dataset.leaf;e.target.checked?S.selected.add(i):S.selected.delete(i);clearExcludedSelection();renderFilters();updatePalette();changed();};
  $('export').onclick=exportView;$('export-cell').onclick=()=>{if(S.cell?.p)download(`NuClass_v15_${S.slide}_${S.cell.x}_${S.cell.y}_posterior.csv`,[['cell_type','posterior','encoding','model','step','checkpoint_sha256'],...taxonomy.leaves.map((n,i)=>[n,S.cell.p[i],'rounded to 1/65535','NuClass v15',59712,manifest.provenance.sourceModel.sha256])]);};
  for(const name of ['types','settings'])$('toggle-'+name).onclick=()=>{const el=$(name+'-panel'),open=el.classList.toggle('open');$('toggle-'+name).setAttribute('aria-expanded',open);};
  for(const canvas of [$('original'),$('tissue')]){
    const pointers=new Map();let last=null,moved=false;
    const local=e=>{const r=canvas.getBoundingClientRect();return[e.clientX-r.left,e.clientY-r.top];};
    const gesture=()=>{const pts=[...pointers.values()];return pts.length>1?{x:(pts[0][0]+pts[1][0])/2,y:(pts[0][1]+pts[1][1])/2,d:Math.hypot(pts[0][0]-pts[1][0],pts[0][1]-pts[1][1])}:{x:pts[0][0],y:pts[0][1],d:0};};
    canvas.addEventListener('wheel',e=>{e.preventDefault();zoom(Math.exp(-e.deltaY*(e.ctrlKey ? .009 : .002)),...local(e));},{passive:false});
    canvas.addEventListener('pointerdown',e=>{canvas.setPointerCapture(e.pointerId);pointers.set(e.pointerId,local(e));last=gesture();moved=pointers.size>1;});
    canvas.addEventListener('pointermove',e=>{if(!pointers.has(e.pointerId)||!S.meta)return;pointers.set(e.pointerId,local(e));const g=gesture(),dx=g.x-last.x,dy=g.y-last.y;if(Math.hypot(dx,dy)>1||g.d)moved=true;S.fit=false;S.cx-=dx/S.scale;S.cy-=dy/S.scale;if(g.d&&last.d)zoom(g.d/last.d,g.x,g.y);last=g;clampCenter();changed();});
    canvas.addEventListener('pointerup',e=>{if(!moved&&pointers.size===1)selectAt(...local(e));pointers.delete(e.pointerId);last=pointers.size?gesture():null;});
    for(const name of ['pointercancel','lostpointercapture'])canvas.addEventListener(name,e=>{pointers.delete(e.pointerId);last=pointers.size?gesture():null;});
    canvas.addEventListener('dblclick',e=>zoom(2,...local(e)));
    canvas.addEventListener('keydown',e=>{if(['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','+','=','-','Home'].includes(e.key)){e.preventDefault();if(e.key==='Home')fit();else if(e.key==='+'||e.key==='=')zoom(1.5);else if(e.key==='-')zoom(1/1.5);else{S.fit=false;S.cx+=(e.key==='ArrowRight'?1:e.key==='ArrowLeft'?-1:0)*S.w/S.scale*.15;S.cy+=(e.key==='ArrowDown'?1:e.key==='ArrowUp'?-1:0)*S.h/S.scale*.15;changed();}}});
  }
  $('minimap').onclick=e=>{if(!S.mini)return;const r=e.target.getBoundingClientRect(),g=S.mini;S.cx=((e.clientX-r.left)/r.width*400-g.x)/g.scale;S.cy=((e.clientY-r.top)/r.height*260-g.y)/g.scale;S.fit=false;changed();};
  document.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','SELECT','TEXTAREA','BUTTON'].includes(document.activeElement.tagName)){e.preventDefault();S.held=true;request();}});
  document.addEventListener('keyup',e=>{if(e.code==='Space'){S.held=false;request();}});window.addEventListener('blur',()=>{S.held=false;request();});
  $('cells').addEventListener('webglcontextlost',e=>{e.preventDefault();status('Graphics paused. Restoring the cell overlay…');});
  $('cells').addEventListener('webglcontextrestored',()=>{initGPU();request();updateStatistics();});
  new ResizeObserver(resize).observe($('overlay-pane'));resize();
}
function updateLayers(){
  const layers=S.layers;S.analysisMode=layers.size===1?[...layers][0]:'combined';
  document.querySelectorAll('[data-analysis-mode]').forEach(b=>{const on=layers.has(b.dataset.analysisMode);b.classList.toggle('active',on);b.setAttribute('aria-pressed',on);});
  const types=layers.has('types'),whole=layers.has('wholecell'),tls=layers.has('tls');
  $('wholecell-controls').hidden=!whole&&!tls;$('type-resolution-controls').hidden=!types;$('celltype-filter-controls').hidden=!types&&!whole;
  for(const id of ['point-style-controls','original-legend','original-selected-panel','export'])$(id).hidden=!types;
  $('wc-tls-settings').hidden=!tls;$('wc-geometry-settings').hidden=!whole;$('wc-selected-panel').hidden=!types&&!whole;
  $('analysis-mode-help').textContent='Choose any combination. Cell types: frozen NuClass v15, step59712, for every supplied valid nucleus. Whole-cell: v6 boundaries + the same v15 identity; unmatched masks stay untyped. TLS: candidate composition / separate stage predictions.';
  const url=new URL(location.href);url.searchParams.set('layers',[...layers].join(','));url.searchParams.set('mode',S.analysisMode);history.replaceState(null,'',url);changed();
}
function setLayer(layer,enabled){if(!['types','wholecell','tls'].includes(layer))return;enabled?S.layers.add(layer):S.layers.delete(layer);updateLayers();}
function setAnalysisMode(mode){
  const names=Array.isArray(mode)?mode:mode===''?[]:String(mode).split(',');if(names.some(n=>!['types','wholecell','tls'].includes(n)))return;
  S.layers=new Set(names);updateLayers();
}
function navigateRegion(sid,b){
  if(sid!==S.slide){selectSlide(sid).then(()=>navigateRegion(sid,b));return;}
  if(!S.meta)return;S.fit=false;S.cx=(b[0]+b[2])/2;S.cy=(b[1]+b[3])/2;S.scale=Math.min(S.w/Math.max(1,b[2]-b[0]),S.h/Math.max(1,b[3]-b[1]))*.82;changed();
}
async function init(){try{manifest=await json('data/manifest-v15.json?v=15');validatePointBase(manifest.point_base);if(manifest.provenance.sourceModel.name!=='NuClass v15'||manifest.provenance.sourceModel.step!==59712)throw Error('Expected frozen NuClass v15');pointReader=createShardReader(()=>manifest.point_base);taxonomy=manifest.taxonomy;resolutionTable=makeResolutionTable(taxonomy);initGPU();
  wholeCell=createWholeCellViewer({canvas:$('wholecells'),state:S,taxonomy,request,navigate:navigateRegion});
  document.querySelectorAll('[data-analysis-mode]').forEach(b=>b.onclick=()=>setLayer(b.dataset.analysisMode,!S.layers.has(b.dataset.analysisMode)));
  const initialParams=new URLSearchParams(location.search);setAnalysisMode(initialParams.has('layers')?initialParams.get('layers'):initialParams.get('mode')||'types');wire();renderFilters();const requested=new URLSearchParams(location.search).get('slide');await selectSlide(manifest.slides.some(s=>s.id===requested)?requested:'S07');
  window.addEventListener('message',async e=>{if(e.origin!==location.origin||e.source!==parent||e.data?.type!=='NUCLASS_OPEN_REGION')return;
    const {slide,id,mode}=e.data;if(!['S03','S07'].includes(slide)||typeof id!=='string')return;
    setLayer(mode||'tls',true);if(S.slide!==slide)await selectSlide(slide);
    const t=setInterval(()=>{if(wholeCell.state.loaded){clearInterval(t);wholeCell.openRegion(id);}},50);setTimeout(()=>clearInterval(t),10000);
  });
}catch(e){status('Viewer could not start: '+e.message,true);$('retry').onclick=()=>location.reload();console.error(e);}}
// A small read-only state surface and explicit controls support reproducible QA.
window.nuclassViewer={state:S,selectSlide,fit,zoom,physical,setResolution,setThreshold,setPreset,setAnalysisMode,setLayer,selectAt,panTo:(x,y)=>{S.fit=false;S.cx=x;S.cy=y;changed();},get wholeCell(){return wholeCell;},get tileCacheSize(){return tiles.size;},get renderer(){return gl?'WebGL':'Canvas2D';}};
if(new URLSearchParams(location.search).has('debug'))window.nuclassViewer.qa={comparePointPixels(){
  if(!gl||!S.ready)throw Error('WebGL point layer is not ready');
  const w=$('cells').width,h=$('cells').height,a=new Uint8Array(w*h*4),b=new Uint8Array(a.length),prior=S.debugFullPoints;
  S.debugFullPoints=false;drawCells();gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,a);
  S.debugFullPoints=true;drawCells();gl.readPixels(0,0,w,h,gl.RGBA,gl.UNSIGNED_BYTE,b);S.debugFullPoints=prior;
  let different=0,nonzero=0;for(let i=0;i<a.length;i++){if(a[i]!==b[i])different++;if(a[i])nonzero++;}
  request();return {different_bytes:different,nonzero_bytes:nonzero,pixels:w*h,original_cells:S.data.n};
}};
init();
