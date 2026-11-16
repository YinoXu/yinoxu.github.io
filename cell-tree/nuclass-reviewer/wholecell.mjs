import {createWholeCellAtlas} from './wholecell-atlas.mjs?v=1';
import {parseWholeCell} from './wholecell-format.mjs?v=4';
import {createShardReader} from './wholecell-shards.mjs?v=4';
import {parseOverview,cellRings,insideRing as insideCellRing} from './wholecell-geometry.mjs?v=4';
import {createContourRenderer,ringsGeometry} from './contour-renderer.mjs?v=4';
const base=new URL('./wholecell/',import.meta.url);
const $=id=>document.getElementById(id), fmt=n=>Number(n).toLocaleString('en-US');
const text=(node,value)=>{if(node)node.textContent=value;};
const escape=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const labels={cell_area_um2:'Cell area',nuc_area_um2:'Nuclear area',cyto_area_um2:'Cytoplasmic area',NC_ratio:'Nuclear / cell area',
 cell_axis_ratio:'Cell axis ratio',nuc_axis_ratio:'Nuclear axis ratio',cell_circularity:'Cell circularity',
 nuc_circularity:'Nuclear circularity',nucleus_offset_um:'Nuclear displacement',cyto_E_mean:'Cytoplasmic eosin OD',
 nuc_H_mean:'Nuclear hematoxylin OD',nuclear_containment:'Nuclear containment',match_distance_um:'Identity-link distance'};
const fixed=(x,n=2)=>Number.isFinite(x)?x.toFixed(n):'Unavailable';

export function createWholeCellViewer({canvas,state:S,taxonomy,request,navigate}){
  const gl=canvas.getContext('webgl',{alpha:true,antialias:false,premultipliedAlpha:false,preserveDrawingBuffer:true});
  const tlsCanvas=$('tlscells'),tlsGL=tlsCanvas.getContext('webgl',{alpha:true,antialias:false,premultipliedAlpha:false,preserveDrawingBuffer:true});
  let manifest,index,colourTouched=false,epoch=0,abort,cache=new Map(),pending=new Map(),failed=new Set(),currentRegion=null,selected=null,geometryBase=base;
  const overviewCache=new Map(),overviewPending=new Map(),nativeJobs=new Map();
  const nativeBudget=96*1024*1024,overviewBudget=192*1024*1024;
  let renderer=null,tlsRenderer=null,worker=null,workerID=0,activeNative=0,activeOverview=0,neededNative=new Set(),neededOverview=new Set(),pickEpoch=0,overviewQueue=[],overviewPaintTimer=0,geometryVersion=0,lastDrawKey=null,lastStyleKey=null,paintedOverview=new Set();
  const shardReader=createShardReader(()=>geometryBase);
  const atlas=createWholeCellAtlas($('wholecell-atlas'),S,()=>geometryBase,()=>{geometryVersion++;request();});
  const controls=$('wholecell-controls');
  controls.innerHTML=`<h2 id="wc-heading">Whole-cell morphology <span class="wc-pill">v6 + v15</span></h2>
    <details id="wc-tls-settings" open><summary>TLS interpretation</summary>
    <label class="wc-label" for="wc-tls-colour">TLS contour colours</label><select id="wc-tls-colour"><option value="composition">NuClass composition phenotype</option><option value="stage">Science E/P/S prediction</option></select>
    <label class="wc-label" for="wc-tls-filter">Show TLS candidates</label><select id="wc-tls-filter"><option value="all">All candidate types</option></select>
    <label class="wc-label" for="wc-tls-boundary">TLS boundary</label><select id="wc-tls-boundary"><option value="refined">H&E-constrained refinement ·5µm</option><option value="raw">Original density mask ·25µm</option></select>
    <label class="setting" for="wc-tls-width">TLS line width <input id="wc-tls-width" type="range" min="1" max="6" step="0.25" value="2.75"></label><div id="wc-tls-counts" class="wc-tls-counts"></div><div id="wc-tls-legend"></div>
    <p class="wc-source">E: early TLS · P: primary follicle · S: secondary follicle. These are model predictions. The refined boundary preserves white spaces and neighbouring candidate identities. Counts, composition and Science stages use the original25µm candidates; boundary sensitivity is separate. Neither outline is pathology gold. Dashed stage outlines indicate crop-sensitive predictions.</p></details>
    <div id="wc-geometry-settings"><label class="check"><input id="wc-show" type="checkbox" checked> Whole-cell contours</label>
    <label class="check wc-check"><input id="wc-nuclei" type="checkbox"> Nuclear contours</label>
    <label class="wc-label" for="wc-cell-style">Whole-cell style</label><select id="wc-cell-style"><option value="outline">Outline</option><option value="filled">Colour fill + outline</option></select>
    <label class="wc-label" for="wc-nucleus-style">Nuclear style</label><select id="wc-nucleus-style"><option value="outline">Outline</option><option value="filled">Colour fill + outline</option></select>
    <label class="check wc-check"><input id="wc-bold" type="checkbox" checked> Bold outlines</label>
    <label class="setting" for="wc-width">Line width <input id="wc-width" type="range" min="0.75" max="6" step="0.25" value="2.25"></label>
    <label class="check wc-check"><input id="wc-halo" type="checkbox"> White outline halo</label>
    <label class="setting" for="wc-opacity">Outline opacity <input id="wc-opacity" type="range" min="0.1" max="1" step="0.05" value="0.95"></label>
    <label class="setting" for="wc-fill-opacity">Fill opacity <input id="wc-fill-opacity" type="range" min="0.05" max="1" step="0.05" value="0.3"></label>
    <label class="check wc-check"><input id="wc-failed" type="checkbox" checked> Include masks rejected for measurement (gray)</label>
    <label class="setting">Colour <select id="wc-colour"><option value="0">NuClass v15 type</option><option value="1">NuClass whole-slide type</option><option value="2">Nuclear / cell area</option><option value="3">Cell area</option><option value="4">Nuclear displacement</option></select></label>
    <div id="wc-scale" class="wc-scale">Type colours match the 47-class palette. Gray: unlinked or QC failure.</div><div class="actions"><button id="wc-export-view">Export cell view</button></div></div>
    <p id="wc-status" class="subtle" role="status" aria-live="polite">Loading whole-cell coverage…</p>
    <button id="wc-retry" hidden>Retry whole-cell data</button>
    <label class="wc-label" for="wc-region">Candidate / control</label><select id="wc-region"><option value="">Choose a region</option></select>
    <div id="wc-region-summary" class="wc-summary"></div>
    <a class="wc-link" href="evidence.html" target="_blank" rel="noopener">Evidence, definitions & all regions ↗</a>
    <details id="wc-review"><summary>Pathology review · saved locally</summary><div id="wc-review-fields"></div>
      <label class="wc-label" for="wc-review-note">Review note</label><textarea id="wc-review-note" rows="3" maxlength="4000"></textarea>
      <div class="actions"><button id="wc-save-review">Save review</button><button id="wc-export-review">Export reviews</button></div><p id="wc-review-state" class="subtle"></p></details>`;
  controls.insertBefore($('wc-geometry-settings'),$('wc-tls-settings'));
  const message=s=>text($('wc-status'),s);
  for(const id of ['wc-show','wc-nuclei','wc-failed','wc-colour','wc-cell-style','wc-nucleus-style','wc-halo'])$(id).onchange=()=>{
    if(id==='wc-colour')colourTouched=true;
    text($('wc-scale'),['Type colours match the 47-class palette. Gray: unlinked or QC failure.',
      'Whole-slide NuClass calls. Whole-cell boundaries still come from v6.',
      'Nuclear / cell area: teal 0 → purple 1.',
      'Cell area: teal ≤32 → purple ≥512 µm² (log scale).',
      'Nuclear displacement: teal 0 → purple ≥10 µm.'][+$('wc-colour').value]);request();
  };
  for(const id of ['wc-width','wc-opacity','wc-fill-opacity','wc-tls-width'])$(id).oninput=()=>{if(id==='wc-width')$('wc-bold').checked=+$('wc-width').value>1.5;request();};
  $('wc-bold').onchange=()=>{$('wc-width').value=$('wc-bold').checked?'2.75':'1';request();};
  $('wc-region').onchange=()=>openRegion($('wc-region').value);
  $('wc-tls-colour').onchange=()=>{dispose(tlsGeometry||{});tlsGeometry=null;$('wc-tls-filter').value='all';renderTLSControls();request();};
  $('wc-tls-filter').onchange=()=>{dispose(tlsGeometry||{});tlsGeometry=null;request();};
  $('wc-tls-boundary').onchange=()=>{dispose(tlsGeometry||{});tlsGeometry=null;if(currentRegion)openRegion(currentRegion.id,false);request();};
  $('wc-retry').onclick=()=>{atlas.retry();failed.clear();$('wc-retry').hidden=true;request();};
  $('wc-save-review').onclick=saveReview;$('wc-export-review').onclick=exportReviews;
  $('wc-export-view').onclick=exportView;
  if(gl)initGL();else message('Whole-cell contours require WebGL. Open the evidence workspace for measurements.');
  const ready=fetch(new URL('manifest.json?v=5',base)).then(r=>{if(!r.ok)throw Error('Whole-cell dataset is not available');return r.json();}).then(m=>{
    manifest=m;if(m.features.length!==16)throw Error('Unexpected measurement schema');
    if(m.geometry_base){const url=new URL(m.geometry_base);if(url.origin!=='https://raw.githubusercontent.com'||!/^\/YinoXu\/yinoxu\.github\.io\/[a-f0-9]{40}\/wholecell\/$/.test(url.pathname))throw Error('Geometry delivery must pin the repository commit');geometryBase=url;}
    return fetch(new URL('schema.json',base));
  }).then(r=>r.json()).then(schema=>{
    manifest.schema=schema;
    $('wc-review-fields').replaceChildren(...schema.criteria.map(c=>{
      const label=document.createElement('label');label.className='wc-criterion';
      const span=document.createElement('span');span.textContent=c.label;
      const sel=document.createElement('select');sel.id='wc-review-'+c.id;sel.setAttribute('aria-label',c.label);
      for(const [value,name] of [['unreviewed','Not reviewed'],['yes','Present / supported'],['no','Absent'],['uncertain','Uncertain'],['unavailable','Not measured']]){const o=document.createElement('option');o.value=value;o.textContent=name;sel.append(o);}
      if(['fdc','hev'].includes(c.id)){sel.value='unavailable';sel.querySelector('[value="yes"]').disabled=true;sel.querySelector('[value="no"]').disabled=true;}
      label.title=c.available;label.append(span,sel);return label;
    }));return manifest;
  }).catch(e=>{message(e.message);throw e;});
  // Consumers may open the existing reviewer while its optional dataset is absent.
  ready.catch(()=>{});

  function initGL(){renderer=createContourRenderer(gl,S);if(tlsGL)tlsRenderer=createContourRenderer(tlsGL,S);}
  function nativeWorker(){
    if(worker)return worker;
    worker=new Worker(new URL('./wholecell-worker.mjs?v=4',import.meta.url),{type:'module'});
    worker.onmessage=({data})=>{const job=nativeJobs.get(data.id);if(!job)return;nativeJobs.delete(data.id);data.error?job.reject(Error(data.error)):job.resolve(data);};
    worker.onerror=()=>{for(const job of nativeJobs.values())job.reject(Error('Contour decoding worker failed'));nativeJobs.clear();worker?.terminate();worker=null;};return worker;
  }
  function buildNative(buffer){const id=++workerID;return new Promise((resolve,reject)=>{nativeJobs.set(id,{resolve,reject});nativeWorker().postMessage({id,epoch,buffer},[buffer]);});}
  function dispose(x){(x.isTLS?tlsRenderer:renderer)?.dispose(x.render||x);}
  function evict(map,keep,budget){let bytes=[...map.values()].reduce((s,x)=>s+x.bytes,0);
    for(const [key,x] of [...map].sort((a,b)=>a[1].used-b[1].used)){if(bytes<=budget)break;if(keep.has(key))continue;dispose(x);map.delete(key);bytes-=x.bytes;}
  }
  async function setSlide(sid){
    const e=++epoch;pickEpoch++;geometryVersion++;lastDrawKey=null;lastStyleKey=null;paintedOverview.clear();clearTimeout(overviewPaintTimer);overviewPaintTimer=0;overviewQueue=[];abort?.abort();abort=new AbortController();for(const job of pending.values())job.controller.abort();for(const job of overviewPending.values())job.controller.abort();pending.clear();overviewPending.clear();activeNative=activeOverview=0;
    worker?.terminate();worker=null;for(const job of nativeJobs.values())job.reject(new DOMException('Slide changed','AbortError'));nativeJobs.clear();
    shardReader.clear();posteriorCache.clear();atlas.setSlide(null);
    for(const x of cache.values())dispose(x);cache.clear();for(const x of overviewCache.values())dispose(x);overviewCache.clear();index=null;currentRegion=null;selected=null;failed.clear();neededNative.clear();neededOverview.clear();
    if(tlsGeometry)dispose(tlsGeometry);tlsGeometry=null;
    $('tls-labels').replaceChildren();text($('wc-region-summary'),'');text($('wc-cell-info'),'Click a cell in a processed region to inspect its actual boundary and measurements.');
    try{await ready;const descriptor=manifest.remote_indexes?.[sid];if(descriptor&&descriptor.file!==`${sid}/index.json`)throw Error('Unexpected full-slide index path');const response=await fetch(descriptor?new URL(descriptor.file,geometryBase):new URL(`${sid}/index.json?v=5`,base),{signal:abort.signal});if(!response.ok)throw Error('No whole-cell analysis for this slide');let m;if(descriptor){const bytes=await response.arrayBuffer();if(bytes.byteLength!==descriptor.bytes)throw Error('Full-slide index length mismatch');const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('');if(digest!==descriptor.sha256)throw Error('Full-slide index integrity mismatch');m=JSON.parse(new TextDecoder().decode(bytes));}else m=await response.json();if(e!==epoch)return;
      if(m.overview_policy?.gpu_bytes>overviewBudget)throw Error('Whole-cell overview exceeds the graphics budget');index=m;atlas.setSlide(m);
      if(m.whole_slide_coverage&&!colourTouched){$('wc-colour').value='0';text($('wc-scale'),'Frozen v15 calls across the complete slide. Gray indicates an unlinked instance or geometry QC failure.');}
      $('wc-region').innerHTML='<option value="">Choose a region</option>'+m.regions.map(c=>`<option value="${escape(c.id)}">${escape(c.label)}</option>`).join('');
      message(`${fmt(m.summary.cells)} predicted cells · ${m.whole_slide_coverage?'complete whole-slide grid':'processed-region coverage'}.`);renderTLSControls();
      const selectedID=new URLSearchParams(location.search).get('candidate');if(selectedID&&m.regions.some(c=>c.id===selectedID))openRegion(selectedID);request();
    }catch(error){if(error.name!=='AbortError'&&e===epoch)message('Whole-cell layer: '+error.message);}
  }
  function intersects(a,b){return a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];}
  function geometryBounds(c){const b=c.bounds,dx=28/S.meta.mpp[0],dy=28/S.meta.mpp[1];return [b[0]-dx,b[1]-dy,b[2]+dx,b[3]+dy];}
  async function load(c,e,kind='native',forSelection=false){
    const overview=kind==='overview',map=overview?overviewPending:pending,target=overview?overviewCache:cache;
    if(target.has(c.key))return target.get(c.key);if(map.has(c.key)){if(forSelection)map.get(c.key).forSelection=true;return map.get(c.key).promise;}
    const controller=new AbortController(),sid=S.slide;
    if(overview)activeOverview++;else activeNative++;
    const promise=(async()=>{try{
      const descriptor=overview?{...c,bundle:c.overview.bundle}:c;
      const buffer=await shardReader.read(sid,descriptor,'geometry',controller.signal);if(e!==epoch)throw new DOMException('Slide changed','AbortError');
      if(!forSelection&&!(overview?neededOverview:neededNative).has(c.key))return null;
      let x;
      if(overview){const geometry=parseOverview(buffer);if(geometry.cells!==c.cells)throw Error('Overview cell count does not match');const render=renderer.upload(geometry,{discardCPU:true});x={render,n:c.cells,bytes:render.gpuBytes};}
      else{const result=await buildNative(buffer);if(e!==epoch)throw new DOMException('Slide changed','AbortError');const parsed=parseWholeCell(result.buffer,{expand:false});
        if(parsed.n!==c.cells)throw Error('Native cell count does not match');const render=renderer.upload(result.geometry,{discardCPU:true});x={...parsed,render,bytes:parsed.buffer.byteLength+render.gpuBytes};}
      if(e!==epoch){dispose(x);throw new DOMException('Slide changed','AbortError');}
      x.key=c.key;x.render.key=c.key;x.descriptor=c;x.used=performance.now();target.set(c.key,x);geometryVersion++;evict(target,overview?neededOverview:neededNative,overview?overviewBudget:nativeBudget);return x;
    }catch(error){if(error.name!=='AbortError'&&e===epoch){failed.add(kind+':'+c.key);$('wc-retry').hidden=false;message('Some contour data could not load. Retry is available.');}return null;}
    finally{if(e===epoch){map.delete(c.key);if(overview){activeOverview--;pumpOverview();if(!overviewPaintTimer)overviewPaintTimer=setTimeout(()=>{overviewPaintTimer=0;request();},250);}else{activeNative--;request();}}}})();map.set(c.key,{controller,promise,forSelection});return promise;
  }
  function pumpOverview(){while(activeOverview<4&&overviewQueue.length){const c=overviewQueue.shift();if(neededOverview.has(c.key)&&!overviewCache.has(c.key)&&!overviewPending.has(c.key)&&!failed.has('overview:'+c.key))load(c,epoch,'overview');}}
  function palette(colors=taxonomy.leaves.map(n=>taxonomy.colors[n]||'#808890')){return new Float32Array(Array.from({length:48},(_,i)=>colors[i]||'#808890').flatMap(c=>c.slice(1).match(/../g).map(x=>parseInt(x,16)/255)));}
  function options(){return {palette:palette(),enabled:new Float32Array(taxonomy.leaves.map((_,i)=>S.selected.has(i)?1:0)),mode:+$('wc-colour').value,
    parts:[$('wc-show').checked?1:0,$('wc-nuclei').checked?1:0],fillParts:[$('wc-show').checked&&$('wc-cell-style').value==='filled'?1:0,$('wc-nuclei').checked&&$('wc-nucleus-style').value==='filled'?1:0],
    width:+$('wc-width').value,alpha:+$('wc-opacity').value,fillAlpha:+$('wc-fill-opacity').value,failed:$('wc-failed').checked,unknown:S.selected.size===47,halo:$('wc-halo').checked};}
  function draw(b,force=false){
    if(!renderer)return;
    const visual=['wc-show','wc-nuclei','wc-cell-style','wc-nucleus-style','wc-width','wc-opacity','wc-fill-opacity','wc-failed','wc-colour','wc-halo','wc-tls-colour','wc-tls-filter','wc-tls-boundary','wc-tls-width'].map(id=>{const e=$(id);return e.type==='checkbox'?e.checked:e.value;});
    const styleKey=JSON.stringify([S.cx,S.cy,S.scale,S.w,S.h,S.dpr,S.clean,S.held,[...(S.layers||[])],[...S.selected],currentRegion?.id,visual]);
    const key=styleKey+':'+geometryVersion;if(!force&&key===lastDrawKey)return;lastDrawKey=key;
    const incremental=!force&&lastStyleKey===styleKey&&S.meta&&S.scale*S.dpr*.425/S.meta.mpp[0]<=.38;lastStyleKey=styleKey;
    if(!incremental){renderer.clear();paintedOverview.clear();}tlsRenderer?.clear();$('tls-labels').replaceChildren();
    canvas.dataset.loaded='0';canvas.dataset.needed='0';canvas.dataset.cells='0';
    if(!b||!index||!S.meta||S.clean||S.held){atlas.draw(null,{},false);return;}
    const layers=S.layers||new Set([S.analysisMode]),whole=layers.has('wholecell'),tls=layers.has('tls');
    $('wc-heading').innerHTML=whole?`Whole-cell morphology <span class="wc-pill">${+$('wc-colour').value===0?'v6 + v15':+$('wc-colour').value===1?'v6 + NuClass':'v6 geometry'}</span>`:'TLS evidence <span class="wc-pill">candidate audit</span>';
    let shown=0,overviewLoaded=0,nativeLoaded=0,visible=[];
    if(whole&&S.selected.size&&($('wc-show').checked||$('wc-nuclei').checked)){
      const chunks=index.chunks.filter(c=>c.cells&&intersects(geometryBounds(c),b)).sort((a,z)=>Math.hypot((a.bounds[0]+a.bounds[2])/2-S.cx,(a.bounds[1]+a.bounds[3])/2-S.cy)-Math.hypot((z.bounds[0]+z.bounds[2])/2-S.cx,(z.bounds[1]+z.bounds[3])/2-S.cy));
      neededOverview=new Set(index.atlas?[]:chunks.map(c=>c.key));
      const nativeDetail=S.scale*S.dpr*.425/S.meta.mpp[0]>.38;
      let reserved=0;const native=nativeDetail?(index.atlas?(chunks.reduce((n,c)=>n+(c.render_bytes_v2||estimate(c)),0)<=nativeBudget?chunks:[]):chunks.filter(c=>{const bytes=c.render_bytes_v2||estimate(c);if(reserved+bytes>nativeBudget)return false;reserved+=bytes;return true;})):[];
      const nativeReady=!!index.atlas&&native.length===chunks.length&&chunks.length>0&&native.every(c=>cache.has(c.key));
      neededNative=new Set(native.map(c=>c.key));
      for(const [key,job] of pending)if(!neededNative.has(key)&&key!==selected?.chunk&&!job.forSelection)job.controller.abort();
      for(const [key,job] of overviewPending)if(!neededOverview.has(key))job.controller.abort();
      const o=options();
      for(const c of chunks){const resident=neededNative.has(c.key)?cache.get(c.key):null,detailed=index.atlas&&!nativeReady?null:resident,coarse=overviewCache.get(c.key);
        if(detailed){detailed.used=performance.now();visible.push(detailed.render);shown+=detailed.n;nativeLoaded++;}
        else if(coarse){coarse.used=performance.now();visible.push(coarse.render);shown+=coarse.n;overviewLoaded++;}

        if(neededNative.has(c.key)&&!resident&&activeNative<1&&!pending.has(c.key)&&!failed.has('native:'+c.key))load(c,epoch);
      }
      overviewQueue=chunks.filter(c=>!index.atlas&&c.overview&&(!nativeDetail||!cache.has(c.key))&&!overviewCache.has(c.key)&&!overviewPending.has(c.key));pumpOverview();
      // Fills precede every stroke, so neighbouring chunks cannot paint over edges.
      const fresh=incremental?visible.filter(g=>!paintedOverview.has(g.key)):visible;
      for(const g of fresh)renderer.filled(g,o);
      for(const g of fresh){paintedOverview.add(g.key);if(o.halo)renderer.stroke(g,o,1,o.width+1.8,o.alpha*.75);renderer.stroke(g,o);}
      renderer.present(o);
      // Switch the entire view only when every native chunk fits and is ready.
      // The pyramid stays complete while detail loads; no mixed-level seams.
      atlas.draw(b,o,!nativeReady);
      evict(cache,neededNative,nativeBudget);evict(overviewCache,neededOverview,overviewBudget);
      const nativeMissing=native.length-nativeLoaded;
      const atlasElement=$('wholecell-atlas'),atlasReady=index.atlas&&atlas.state.supported&&(nativeReady||atlasElement.dataset.loaded===atlasElement.dataset.needed);
      if(atlas.state.failed)$('wc-retry').hidden=false;
      if(index.atlas&&!atlas.state.supported)message('Full-slide overlay is unavailable in this browser. Native contours remain available when you zoom in.');
      else if(index.atlas)message(`${fmt(chunks.reduce((n,c)=>n+c.cells,0))} predicted cells in intersecting chunks · ${atlasReady?'full-slide overlay ready':'loading full-slide overlay…'}${nativeLoaded?' + native contours':''}. ${+$('wc-colour').value===0?'Frozen v15 types; gray indicates unlinked or failed geometry.':''}`);
      else message(chunks.length?`${fmt(shown)} / ${fmt(chunks.reduce((n,c)=>n+c.cells,0))} cells · ${nativeLoaded?'Native detail':'Overview contours'}${nativeMissing?' · loading finer detail…':''}. Zoom in to inspect individual boundaries.`:'Outside processed whole-cell coverage. No predicted boundary is available here.');
      Object.assign(canvas.dataset,{loaded:String(atlasReady?chunks.length:nativeLoaded+overviewLoaded),needed:String(chunks.length),intersecting:String(chunks.length),cells:String(atlasReady?chunks.reduce((n,c)=>n+c.cells,0):shown),native:String(nativeLoaded),overview:String(overviewLoaded),cache:String(cache.size),cacheBytes:String([...cache.values()].reduce((n,x)=>n+x.bytes,0)+[...overviewCache.values()].reduce((n,x)=>n+x.bytes,0)),renderer:'WebGL cell contours'});
    }else{neededNative=new Set();neededOverview=new Set();overviewQueue=[];atlas.draw(null,{},false);}
    if(tls)drawTLS(b,whole);
  }
  function estimate(c){return c.render_bytes_v2||c.decoded_bytes*12;}
  function openRegion(id,move=true){
    const r=index?.regions.find(c=>c.id===id);if(!r)return;currentRegion=r;$('wc-region').value=id;
    const m=r.metrics||{};const lines=[r.label,r.control?'Prespecified image-only control; not pathology-negative gold.':'Previously detected candidate; pathology status unreviewed.'];
    const count=n=>Number.isFinite(n)?fmt(n):'Unavailable';
    if(!r.control)lines.push(`v15 T ${count(m.T)} · B ${count(m.B)} · ${fixed(m.area_mm2,3)} mm²`,
      `Lymphoid fraction ${fixed(m.lymphoid_fraction_score,1)}% · B/T zoning ${fixed(m.zoning_score,1)}/100`,
      `Usable whole-cell links ${fixed(m.quality_score,1)}% of original candidate nuclei`,
      `Composition: ${r.composition_type||'Unscored'}`,
      `Science stage: ${stageLabels[r.science?.stage]||'Unassigned'} · model prediction`,
      r.science?.stable===false?'Stage changes with crop handling. Inspect before interpreting.':'Pathology stage is unverified.');
    if(r.boundary_refinement){const q=r.boundary_refinement,c=q.composition_comparison;
      lines.push(`Boundary comparison: refined area ${q.area_change_pct>=0?'+':''}${fixed(q.area_change_pct,1)}% · mask agreement IoU ${fixed(q.raw_refined_IoU,3)} (not accuracy)`,
        q.review_required?'Boundary change requires visual review.':'Original candidate metrics remain the analysis baseline.');
      if(c)lines.push(`Boundary sensitivity: nuclei ${fmt(c.raw.nuclei)}→${fmt(c.refined.nuclei)} · B ${fmt(c.raw.B)}→${fmt(c.refined.B)} · T ${fmt(c.raw.T)}→${fmt(c.refined.T)}`);
    }
    text($('wc-region-summary'),lines.join('\n'));
    const selectedEpoch=epoch;const tryNavigate=()=>{if(selectedEpoch!==epoch)return;if(S.meta){if(move)navigate(S.slide,r.bounds);}else setTimeout(tryNavigate,50);};tryNavigate();restoreReview();
    const url=new URL(location.href);url.searchParams.set('candidate',id);history.replaceState(null,'',url);
  }
  const compNames=['B-rich','T-rich','B/T segregated','B/T mixed','B/T intermediate','Low lymphoid / discordant','Unscored'];
  const compColors=['#7763c4','#2f9b9e','#d09838','#c35d93','#587da3','#8a979e','#a9afb5'];
  const stageLabels={E:'E · Early TLS',P:'P · Primary follicle-like TLS',S:'S · Secondary follicle-like TLS',Unassigned:'Unassigned'};
  const stageNames=['E','P','S','Unassigned'],stageColors=['#ce9237','#529ab9','#a061b6','#8a979e'];
  let tlsGeometry=null;
  function regionRings(r){return $('wc-tls-boundary').value==='refined'&&r.refined_rings?r.refined_rings:(r.raw_rings||r.rings||[]);}
  function tlsClass(r){return $('wc-tls-colour').value==='stage'?(r.science?.stage||'Unassigned'):(r.composition_type||'Unscored');}
  function renderTLSControls(){
    if(!index)return;const stage=$('wc-tls-colour').value==='stage',names=stage?stageNames:compNames,colors=stage?stageColors:compColors;
    const candidates=index.regions.filter(r=>!r.control),count=Object.fromEntries(names.map(n=>[n,candidates.filter(r=>tlsClass(r)===n).length]));
    $('wc-tls-filter').innerHTML='<option value="all">All candidate types</option>'+names.map(n=>`<option value="${escape(n)}">${escape(n)} · ${count[n]}</option>`).join('');
    text($('wc-tls-counts'),`${candidates.length} candidate regions · ${fixed(index.summary.candidate_area_mm2,2)} mm² total · ${fixed(index.summary.candidate_density,2)} candidates / mm² tissue`);
    $('wc-tls-legend').innerHTML=names.filter(n=>count[n]).map(n=>`<div class="wc-legend"><i style="background:${colors[names.indexOf(n)]}"></i>${escape(stage?stageLabels[n]:n)} <b>${count[n]}</b></div>`).join('');
  }
  function drawTLS(b,withCells=false){
    if(!tlsRenderer)return;
    const stage=$('wc-tls-colour').value==='stage',names=stage?stageNames:compNames,colors=stage?stageColors:compColors,filter=$('wc-tls-filter').value;
    const selected=index.regions.filter(r=>!r.control&&(filter==='all'||tlsClass(r)===filter));
    if(!tlsGeometry){const rings=[];
      for(const r of selected)for(const xy of regionRings(r))rings.push({xy,kind:0,leaf:Math.max(0,names.indexOf(tlsClass(r))),dash:stage&&r.science?.stable===false});
      tlsGeometry=tlsRenderer.upload(ringsGeometry(rings),{discardCPU:true});tlsGeometry.isTLS=true;
    }
    const o={palette:palette(colors),enabled:new Float32Array(47).fill(1),mode:0,parts:[1,1],width:+$('wc-tls-width').value,alpha:1,failed:true,unknown:true};
    tlsRenderer.stroke(tlsGeometry,o);tlsRenderer.present({...o,halo:true});
    const visible=selected.filter(r=>intersects(r.bounds,b));
    const annotated=visible.sort((a,z)=>(z.id===currentRegion?.id)-(a.id===currentRegion?.id)||(z.metrics?.area_mm2||0)-(a.metrics?.area_mm2||0)),boxes=[];
    for(const r of annotated){if(boxes.length>=8)break;const label=`${r.slide||S.slide} C${String(r.candidate_id).padStart(3,'0')} · ${tlsClass(r)}`;
      const w=Math.min(S.w-20,label.length*5.6+12),h=20,x=Math.max(w/2+5,Math.min(S.w-w/2-5,((r.bounds[0]+r.bounds[2])/2-S.cx)*S.scale+S.w/2)),y=Math.max(60,Math.min(S.h-25,((r.bounds[1]+r.bounds[3])/2-S.cy)*S.scale+S.h/2));
      const box=[x-w/2,y-h/2,x+w/2,y+h/2];if(boxes.some(b=>intersects(b,[box[0]-5,box[1]-5,box[2]+5,box[3]+5])))continue;
      const span=document.createElement('span');span.textContent=label;span.style.left=`${x}px`;span.style.top=`${y}px`;$('tls-labels').append(span);boxes.push(box);}
    if(!withCells)message(`${visible.length} candidates intersect this view · ${selected.length}/${index.summary.candidates} selected on ${S.slide}. Click a contour to inspect composition and stage evidence.`);
    if(!withCells)canvas.dataset.renderer='WebGL TLS contours';canvas.dataset.tlsVisible=visible.length;canvas.dataset.tlsSelected=selected.length;
  }
  function insideRing(x,y,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [xi,yi]=ring[i],[xj,yj]=ring[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;}return inside;}
  function pickRegion(x,y){const filter=$('wc-tls-filter').value;
    const r=index?.regions.find(r=>!r.control&&(filter==='all'||tlsClass(r)===filter)&&x>=r.bounds[0]&&x<=r.bounds[2]&&y>=r.bounds[1]&&y<=r.bounds[3]&&
      regionRings(r).reduce((v,ring)=>v!==insideRing(x,y,ring),false));
    if(r)openRegion(r.id);return r||null;
  }
  function clearSelection(){pickEpoch++;selected=null;request();}
  function pick(x,y,{nuclear=false,chunk:selectionChunk=null}={}){
    if(!index||!S.selected.size||S.clean||S.held)return null;let best=null,minimum=Infinity;
    for(const chunk of (selectionChunk?[selectionChunk]:cache.values())){
      if(x<chunk.descriptor.bounds[0]-50||x>chunk.descriptor.bounds[2]+50||y<chunk.descriptor.bounds[1]-50||y>chunk.descriptor.bounds[3]+50)continue;
      for(let i=0;i<chunk.n;i++){
        const r=chunk.record(i),li=nuclear||+$('wc-colour').value===1?r.cellstp:r.leaf;
        if((li<47&&!S.selected.has(li))||(li>46&&S.selected.size<47)||(!$('wc-failed').checked&&!(r.flags&1)))continue;
        const distance=Math.hypot((r.x-x)*S.meta.mpp[0],(r.y-y)*S.meta.mpp[1]);if(distance>35||distance>=minimum)continue;
        const rings=cellRings(chunk,i),kind=nuclear?1:0,contained=rings.filter(p=>p.kind===kind||p.kind===kind+2).reduce((hit,p)=>hit!==insideCellRing(x,y,p.xy),false);
        if(!contained)continue;minimum=distance;best={...r,chunk:chunk.key,chunkIndex:i,rings};
      }
    }
    if(!best)return null;selected=best;renderCell(best);request();return best;
  }
  async function selectAt(x,y,options={}){
    const id=++pickEpoch,e=epoch;if(!index)return null;
    let result=pick(x,y,options);if(result)return result;
    const candidates=index.chunks.filter(c=>c.cells&&(()=>{const b=geometryBounds(c);return x>=b[0]&&x<=b[2]&&y>=b[1]&&y<=b[3];})());
    for(const c of candidates){const chunk=await load(c,e,'native',true);if(id!==pickEpoch||e!==epoch)return null;if(chunk&&(result=pick(x,y,{...options,chunk})))return result;}
    if(id===pickEpoch){selected=null;text($('wc-cell-info'),'No predicted whole-cell boundary contains this position in the processed regions. The source nucleus marker is shown instead.');request();}return null;
  }
  function drawSelection(contexts){
    if(!selected||S.clean||S.held||!S.layers.has('types')&&!S.layers.has('wholecell'))return false;
    for(const context of contexts)for(const ring of selected.rings.filter(r=>r.kind===0||r.kind===2)){
      const points=ring.xy;if(!points.length)continue;context.beginPath();context.moveTo((points[0][0]-S.cx)*S.scale+S.w/2,(points[0][1]-S.cy)*S.scale+S.h/2);
      for(let i=1;i<points.length;i++)context.lineTo((points[i][0]-S.cx)*S.scale+S.w/2,(points[i][1]-S.cy)*S.scale+S.h/2);
      context.closePath();context.lineJoin='round';context.strokeStyle='#fff';context.lineWidth=5;context.stroke();context.strokeStyle='#087b91';context.lineWidth=2.5;context.stroke();
    }return true;
  }
  function renderCell(r){
    const li=r.leaf<47?taxonomy.labels[taxonomy.leaves[r.leaf]]:'Unlinked / unavailable';
    const old=r.cellstp<47?taxonomy.labels[taxonomy.leaves[r.cellstp]]:'Unlinked';const good=!!(r.flags&1);
    const values=manifest.features.map((key,i)=>({key,value:r.features[i]})).filter(x=>x.key in labels),stats=index.class_stats?.[taxonomy.leaves[r.leaf]];
    $('wc-cell-info').innerHTML=`<div class="cell-name">${escape(li)}</div><div class="cell-meta">NuClass v15 · ${Number.isFinite(r.p[0])?fixed(r.p[0]*100,1)+'% posterior':'no linked posterior'} · v6 geometry<br>Whole-slide NuClass: ${escape(old)}<br>${good?'Complete single-nucleus geometry':'QC failure: inspect gray contour'} · ${r.nuclei} associated nuclei<br>Native identity link: ${r.row>=0?'unique nuclear match':'unmatched'}</div>
      <table class="wc-feature-table"><thead><tr><th>Measurement</th><th>This cell</th><th title="Median among cells called the same type by v15 on this slide">Type median</th></tr></thead><tbody>${values.map(v=>`<tr><th>${escape(labels[v.key])}</th><td>${fixed(v.value,v.key==='NC_ratio'?3:2)}${v.key.endsWith('_um2')?' µm²':v.key.endsWith('_um')?' µm':''}</td><td>${fixed(stats?.features[v.key]?.median,v.key==='NC_ratio'?3:2)}</td></tr>`).join('')}</tbody></table>
      <p class="subtle">Measured morphology describes this prediction. See the decision audit for how well morphology explains frozen v15 scores; these measurements alone do not prove model dependence or true identity.</p>
      <button id="wc-export-cell">Export cell measurements</button><details><summary>Native v15 · 47 posteriors</summary><div id="wc-posteriors">Loading…</div></details>`;
    loadPosterior(r);
    $('wc-export-cell').onclick=()=>{
      const v={slide:S.slide,id:r.id,source_row:r.row,x:r.x,y:r.y,model:'NuClass v15 step59712',segmentation:'v6 EMA1000',geometry_QC:good,
        predicted_type:li,original_cellstp_type:old,...Object.fromEntries(manifest.features.map((k,i)=>[k,Number.isFinite(r.features[i])?r.features[i]:null]))};
      download(`wholecell_${S.slide}_${r.id}.json`,JSON.stringify(v,null,2),'application/json');
    };
  }
  const posteriorCache=new Map();
  async function loadPosterior(r){
    const sid=S.slide,e=epoch,key=sid+'/'+r.chunk;try{
      let data=posteriorCache.get(key);
      if(!data){const descriptor=index.chunks.find(c=>c.key===r.chunk);const b=await shardReader.read(sid,descriptor,'posterior',abort.signal);
        const count=new DataView(b).getUint32(0,true);if(b.byteLength!==4+count*47*2)throw Error('Invalid v15 posterior shard');data=new Uint16Array(b,4);posteriorCache.set(key,data);if(posteriorCache.size>4)posteriorCache.delete(posteriorCache.keys().next().value);}
      if(e!==epoch||selected?.id!==r.id)return;const values=Array.from(data.subarray(r.chunkIndex*47,(r.chunkIndex+1)*47),p=>p/65535);
      if(values.every(x=>x===0)){text($('wc-posteriors'),'No linked v15 posterior.');return;}
      $('wc-posteriors').innerHTML='<p class="subtle">Native v15 scores rounded to1/65535; not accuracy and not renormalised.</p>'+taxonomy.leaves.map((n,i)=>({n,p:values[i]})).sort((a,b)=>b.p-a.p).map(({n,p})=>`<div class="prob-row"><span>${escape(taxonomy.labels[n]||n)}</span><span>${fixed(p*100,2)}%</span></div>`).join('');
    }catch(error){if(error.name!=='AbortError'&&e===epoch&&selected?.id===r.id)text($('wc-posteriors'),'Native posterior could not load. Select the cell again to retry.');}
  }
  function exportView(){
    if(!index||!S.meta)return;const b=[S.cx-S.w/S.scale/2,S.cy-S.h/S.scale/2,S.cx+S.w/S.scale/2,S.cy+S.h/S.scale/2],records=[];
    for(const chunk of cache.values())for(let i=0;i<chunk.n;i++){
      const r=chunk.record(i);if(r.x<b[0]||r.x>b[2]||r.y<b[1]||r.y>b[3]||(!$('wc-failed').checked&&!(r.flags&1)))continue;
      const li=+$('wc-colour').value===1?r.cellstp:r.leaf;if(li<47&&!S.selected.has(li)||li===255&&S.selected.size<47)continue;
      records.push({id:r.id,slide:S.slide,x:r.x,y:r.y,source_row:r.row,v15_type:taxonomy.leaves[r.leaf]||'Unavailable',
        cellstp_type:taxonomy.leaves[r.cellstp]||'Unavailable',geometry_QC:!!(r.flags&1),...Object.fromEntries(manifest.features.map((k,j)=>[k,Number.isFinite(r.features[j])?r.features[j]:null]))});
    }
    download(`wholecell_${S.slide}_loaded_view.json`,JSON.stringify({scope:'Visible centres in currently loaded contour chunks; see coverage status',model:'v6 EMA1000 + NuClass v15 selected59712',cells:records},null,2),'application/json');
  }
  function reviewKey(){return `nuclass-tls-review-v1:${S.slide}:${currentRegion?.id||'none'}`;}
  function restoreReview(){
    if(!manifest?.schema)return;let r={};try{r=JSON.parse(localStorage.getItem(reviewKey())||'{}');}catch{}
    for(const c of manifest.schema.criteria){$('wc-review-'+c.id).value=r.criteria?.[c.id]||(['fdc','hev'].includes(c.id)?'unavailable':'unreviewed');}
    $('wc-review-note').value=r.note||'';text($('wc-review-state'),r.utc?'Saved locally '+r.utc:'Review is not yet saved.');
  }
  function saveReview(){
    if(!currentRegion){text($('wc-review-state'),'Choose a candidate or control before saving a review.');return;}
    const criteria=Object.fromEntries(manifest.schema.criteria.map(c=>[c.id,$('wc-review-'+c.id).value]));
    const r={version:'0.1',slide:S.slide,region:currentRegion.id,utc:new Date().toISOString(),criteria,note:$('wc-review-note').value,
      scope:'Local expert observation; not new ground truth or an automatic TLS diagnosis',no_matching_IHC:true};
    try{localStorage.setItem(reviewKey(),JSON.stringify(r));text($('wc-review-state'),'Saved in this browser. No annotation was uploaded.');}
    catch{text($('wc-review-state'),'Browser storage unavailable. Export your review before leaving.');download(`review_${currentRegion.id}.json`,JSON.stringify(r,null,2),'application/json');}
  }
  function exportReviews(){const rows=[];try{for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith('nuclass-tls-review-v1:'))rows.push(JSON.parse(localStorage.getItem(k)));}}catch{}
    download('NuClass_TLS_local_reviews.json',JSON.stringify(rows,null,2),'application/json');}
  function download(name,body,type){const url=URL.createObjectURL(new Blob([body],{type})),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  canvas.addEventListener('webglcontextlost',e=>{e.preventDefault();message('Whole-cell graphics interrupted; restoring…');});
  tlsCanvas.addEventListener('webglcontextlost',e=>{e.preventDefault();});
  tlsCanvas.addEventListener('webglcontextrestored',()=>{tlsRenderer=createContourRenderer(tlsGL,S);tlsGeometry=null;lastDrawKey=null;request();});
  canvas.addEventListener('webglcontextrestored',()=>{initGL();cache.clear();overviewCache.clear();tlsGeometry=null;lastDrawKey=null;request();});
  function readback(){const b=[S.cx-S.w/S.scale/2,S.cy-S.h/S.scale/2,S.cx+S.w/S.scale/2,S.cy+S.h/S.scale/2],start=performance.now();draw(b,true);const pixels=new Uint8Array(canvas.width*canvas.height*4);gl.readPixels(0,0,canvas.width,canvas.height,gl.RGBA,gl.UNSIGNED_BYTE,pixels);let coloured=0;for(let i=3;i<pixels.length;i+=4)if(pixels[i])coloured++;return {coloured_pixels:coloured,width:canvas.width,height:canvas.height,draw_readback_ms:performance.now()-start,...canvas.dataset};}
  return {setSlide,draw,pick,selectAt,clearSelection,drawSelection,pickRegion,openRegion,readback,get state(){return {slide:S.slide,loaded:!!index,cache:cache.size,bytes:[...cache.values()].reduce((s,x)=>s+x.bytes,0),atlas:atlas.state,overviewBytes:[...overviewCache.values()].reduce((s,x)=>s+x.bytes,0),overviewLoaded:overviewCache.size,compressed:shardReader.state,regions:index?.regions.length||0,epoch,selected};},get manifest(){return manifest;},get index(){return index;},get cache(){return cache;}};
}
