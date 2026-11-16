import {parseWholeCell} from './wholecell-format.mjs';
import {createShardReader} from './wholecell-shards.mjs';
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
  const gl=canvas.getContext('webgl',{alpha:true,antialias:false,premultipliedAlpha:false});
  let manifest,index,epoch=0,abort,program,u={},cache=new Map(),pending=new Map(),failed=new Set(),active=0,currentRegion=null,selected=null,lastView=null,geometryBase=base;
  const limitBytes=120*1024*1024,limitChunks=32;
  const shardReader=createShardReader(()=>geometryBase);
  const controls=$('wholecell-controls');
  controls.innerHTML=`<h2 id="wc-heading">Whole-cell morphology <span class="wc-pill">v6 + v15</span></h2>
    <details id="wc-tls-settings" open><summary>TLS interpretation</summary>
    <label class="wc-label" for="wc-tls-colour">TLS contour colours</label><select id="wc-tls-colour"><option value="composition">NuClass composition phenotype</option><option value="stage">Science E/P/S prediction</option></select>
    <label class="wc-label" for="wc-tls-filter">Show TLS candidates</label><select id="wc-tls-filter"><option value="all">All candidate types</option></select>
    <label class="wc-label" for="wc-tls-boundary">TLS boundary</label><select id="wc-tls-boundary"><option value="refined">H&E-constrained refinement ·5µm</option><option value="raw">Original density mask ·25µm</option></select>
    <div id="wc-tls-counts" class="wc-tls-counts"></div><div id="wc-tls-legend"></div>
    <p class="wc-source">E: early TLS · P: primary follicle · S: secondary follicle. These are model predictions. The refined boundary preserves white spaces and neighbouring candidate identities. Counts, composition and Science stages use the original25µm candidates; boundary sensitivity is separate. Neither outline is pathology gold. Dashed stage outlines indicate crop-sensitive predictions.</p></details>
    <div id="wc-geometry-settings"><label class="check"><input id="wc-show" type="checkbox" checked> Whole-cell contours</label>
    <label class="check wc-check"><input id="wc-nuclei" type="checkbox"> Nuclear contours</label>
    <label class="check wc-check"><input id="wc-failed" type="checkbox" checked> Show QC failures in gray</label>
    <label class="setting">Colour <select id="wc-colour"><option value="0">NuClass v15 type</option><option value="1">Original CellSTP type</option><option value="2">Nuclear / cell area</option><option value="3">Cell area</option><option value="4">Nuclear displacement</option></select></label>
    <div id="wc-scale" class="wc-scale">Type colours match the 47-class palette. Gray: unlinked or QC failure.</div><div class="actions"><button id="wc-export-view">Export cell view</button></div></div>
    <p id="wc-status" class="subtle" role="status" aria-live="polite">Loading whole-cell coverage…</p>
    <button id="wc-retry" hidden>Retry whole-cell data</button>
    <label class="wc-label" for="wc-region">Candidate / control</label><select id="wc-region"><option value="">Choose a region</option></select>
    <div id="wc-region-summary" class="wc-summary"></div>
    <a class="wc-link" href="evidence.html" target="_blank" rel="noopener">Evidence, definitions & all regions ↗</a>
    <details id="wc-review"><summary>Pathology review · saved locally</summary><div id="wc-review-fields"></div>
      <label class="wc-label" for="wc-review-note">Review note</label><textarea id="wc-review-note" rows="3" maxlength="4000"></textarea>
      <div class="actions"><button id="wc-save-review">Save review</button><button id="wc-export-review">Export reviews</button></div><p id="wc-review-state" class="subtle"></p></details>`;
  const message=s=>text($('wc-status'),s);
  for(const id of ['wc-show','wc-nuclei','wc-failed','wc-colour'])$(id).onchange=()=>{
    text($('wc-scale'),['Type colours match the 47-class palette. Gray: unlinked or QC failure.',
      'Original CellSTP calls. Whole-cell boundaries still come from v6.',
      'Nuclear / cell area: teal 0 → purple 1.',
      'Cell area: teal ≤32 → purple ≥512 µm² (log scale).',
      'Nuclear displacement: teal 0 → purple ≥10 µm.'][+$('wc-colour').value]);request();
  };
  $('wc-region').onchange=()=>openRegion($('wc-region').value);
  $('wc-tls-colour').onchange=()=>{dispose(tlsGeometry||{});tlsGeometry=null;$('wc-tls-filter').value='all';renderTLSControls();request();};
  $('wc-tls-filter').onchange=()=>{dispose(tlsGeometry||{});tlsGeometry=null;request();};
  $('wc-tls-boundary').onchange=()=>{dispose(tlsGeometry||{});tlsGeometry=null;if(currentRegion)openRegion(currentRegion.id,false);request();};
  $('wc-retry').onclick=()=>{failed.clear();$('wc-retry').hidden=true;request();};
  $('wc-save-review').onclick=saveReview;$('wc-export-review').onclick=exportReviews;
  $('wc-export-view').onclick=exportView;
  if(gl)initGL();else message('Whole-cell contours require WebGL. Open the evidence workspace for measurements.');
  const ready=fetch(new URL('manifest.json',base)).then(r=>{if(!r.ok)throw Error('Whole-cell dataset is not available');return r.json();}).then(m=>{
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

  function shader(type,source){const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;}
  function initGL(){
    program=gl.createProgram();
    gl.attachShader(program,shader(gl.VERTEX_SHADER,`precision highp float;
      attribute vec2 a_xy;attribute vec4 a_style;attribute vec3 a_values;
      uniform vec2 u_center,u_view;uniform float u_scale,u_mode,u_nuclei,u_failed,u_coverage,u_tls,u_unknown;
      uniform vec3 u_colors[48];uniform float u_enabled[47];varying mediump vec4 v_color;varying mediump float v_dash;varying highp float v_along;
      void main(){vec2 p=(a_xy-u_center)*u_scale/u_view*2.;gl_Position=vec4(p.x,-p.y,0.,1.);
        int li=int(u_mode<.5?a_style.x:a_style.y);float qc=a_style.z;
        vec3 col=u_colors[int(min(float(li),47.0))];float alpha=.9;
        if(u_mode>1.5){float t=clamp(u_mode<2.5?a_values.x:(u_mode<3.5?a_values.y:a_values.z),0.,1.);col=mix(vec3(.04,.7,.65),vec3(.68,.08,.82),t);}
        if(u_tls<.5&&(qc<.5||li>46)){col=vec3(.48,.54,.59);alpha=.55;}
        if(u_coverage>.5){col=vec3(.1,.62,.55);alpha=.20;}
        else{if(mod(a_style.w,2.)>.5&&u_nuclei<.5)gl_Position=vec4(3.,3.,0.,1.);
          if(qc<.5&&u_failed<.5)gl_Position=vec4(3.,3.,0.,1.);
          if(li>46&&u_unknown<.5)gl_Position=vec4(3.,3.,0.,1.);
          if(li<47&&u_enabled[li]<.5)gl_Position=vec4(3.,3.,0.,1.);}
        v_dash=u_tls>.5&&a_values.y>.5?1.:0.;v_along=a_values.x*u_scale;
        v_color=vec4(col,alpha);}`));
    gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`precision mediump float;varying mediump vec4 v_color;varying mediump float v_dash;varying highp float v_along;void main(){if(v_dash>.5&&mod(v_along,10.)<4.)discard;gl_FragColor=v_color;}`));
    gl.linkProgram(program);if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
    u={};for(const s of ['center','view','scale','mode','nuclei','failed','coverage','tls','unknown','colors','enabled'])u[s]=gl.getUniformLocation(program,'u_'+s);
    u.xy=gl.getAttribLocation(program,'a_xy');u.style=gl.getAttribLocation(program,'a_style');u.values=gl.getAttribLocation(program,'a_values');
    gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);
  }
  function dispose(x){if(gl&&x.gpu)for(const b of Object.values(x.gpu))gl.deleteBuffer(b);}
  function evict(keep,budget=limitBytes,maxCount=limitChunks){let total=[...cache.values()].reduce((s,x)=>s+x.bytes,0);
    for(const [key,x] of [...cache].sort((a,b)=>a[1].used-b[1].used)){
      if(cache.size<=maxCount&&total<=budget)break;if(keep.has(key))continue;dispose(x);cache.delete(key);total-=x.bytes;
    }
  }
  async function setSlide(sid){
    const e=++epoch;abort?.abort();abort=new AbortController();for(const a of pending.values())a.abort();pending.clear();active=0;
    shardReader.clear();
    for(const x of cache.values())dispose(x);cache.clear();index=null;currentRegion=null;selected=null;failed.clear();
    if(coverage)dispose(coverage);coverage=null;if(tlsGeometry)dispose(tlsGeometry);tlsGeometry=null;
    $('tls-labels').replaceChildren();
    text($('wc-region-summary'),'');text($('wc-cell-info'),'Choose a cell in a processed region to inspect its measured compartments.');
    try{await ready;const r=await fetch(new URL(`${sid}/index.json`,base),{signal:abort.signal});if(!r.ok)throw Error('No whole-cell analysis for this slide');const m=await r.json();if(e!==epoch)return;
      index=m;$('wc-region').innerHTML='<option value="">Choose a region</option>'+
        m.regions.map(c=>`<option value="${escape(c.id)}">${escape(c.label)}</option>`).join('');
      message(`${fmt(m.summary.cells)} predicted cells · ${m.summary.candidates} candidate regions processed. Zoom in for contours.`);renderTLSControls();
      const selectedID=new URLSearchParams(location.search).get('candidate');if(selectedID&&m.regions.some(c=>c.id===selectedID))openRegion(selectedID);request();
    }catch(error){if(error.name!=='AbortError'&&e===epoch)message('Whole-cell layer: '+error.message);}
  }
  function intersects(a,b){return a[0]<=b[2]&&a[2]>=b[0]&&a[1]<=b[3]&&a[3]>=b[1];}
  function upload(x){
    x.gpu={};for(const [key,array] of [['xy',x.xy],['style',x.style],['values',x.values]]){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,array,gl.STATIC_DRAW);x.gpu[key]=b;}
  }
  async function load(c,e){
    const controller=new AbortController();pending.set(c.key,controller);active++;
    try{const b=await shardReader.read(S.slide,c,'geometry',controller.signal);if(e!==epoch)return;
      if(!lastView?.has(c.key)||S.analysisMode!=='wholecell')return;
      const x=parseWholeCell(b);if(x.n!==c.cells)throw Error('Whole-cell count does not match its index');
      if(x.bytes>estimate(c))throw Error('Contour cache estimate is inconsistent');
      x.used=performance.now();x.key=c.key;x.descriptor=c;if(gl)upload(x);cache.set(c.key,x);
    }catch(error){if(error.name!=='AbortError'&&e===epoch){failed.add(c.key);$('wc-retry').hidden=false;message('Some whole-cell chunks failed to load. Retry is available.');}}
    finally{if(e===epoch){pending.delete(c.key);active--;request();}}
  }
  function draw(b){
    if(!gl)return;gl.viewport(0,0,canvas.width,canvas.height);gl.clearColor(0,0,0,0);gl.clear(gl.COLOR_BUFFER_BIT);
    $('tls-labels').replaceChildren();
    if(!b||!index||!S.meta||S.analysisMode==='types'||S.clean||S.held)return;
    $('wc-heading').innerHTML=S.analysisMode==='tls'?'TLS evidence <span class="wc-pill">candidate audit</span>':'Whole-cell morphology <span class="wc-pill">v6 + v15</span>';
    gl.useProgram(program);gl.uniform2f(u.center,S.cx,S.cy);gl.uniform2f(u.view,S.w,S.h);gl.uniform1f(u.scale,S.scale);
    gl.uniform1f(u.tls,0);gl.uniform1f(u.unknown,S.selected.size===47?1:0);
    gl.uniform1f(u.mode,+$('wc-colour').value);gl.uniform1f(u.nuclei,$('wc-nuclei').checked?1:0);gl.uniform1f(u.failed,$('wc-failed').checked?1:0);
    const pal=[...taxonomy.leaves.map(n=>taxonomy.colors[n]||'#808890'),'#808890'].flatMap(c=>c.slice(1).match(/../g).map(x=>parseInt(x,16)/255));
    gl.uniform3fv(u.colors,new Float32Array(pal));gl.uniform1fv(u.enabled,new Float32Array(taxonomy.leaves.map((_,i)=>S.selected.has(i)?1:0)));
    if(S.analysisMode==='tls'){drawTLS(b);return;}
    if(S.selected.size===0)return;
    if(!$('wc-show').checked)return;
    const width=(b[2]-b[0])*S.meta.mpp[0],height=(b[3]-b[1])*S.meta.mpp[1];
    if(Math.max(width,height)>1600){
      message(`Processed coverage shown in teal. Zoom to ≤1.6 mm on the longer axis for whole-cell contours. ${index.summary.candidates} candidates + controls.`);
      drawCoverage();return;
    }
    const chunks=index.chunks.filter(c=>intersects(c.bounds,b));
    const sorted=chunks.sort((a,z)=>Math.hypot((a.bounds[0]+a.bounds[2])/2-S.cx,(a.bounds[1]+a.bounds[3])/2-S.cy)-Math.hypot((z.bounds[0]+z.bounds[2])/2-S.cx,(z.bounds[1]+z.bounds[3])/2-S.cy));
    let reserved=0;const admitted=[];
    for(const c of sorted)if(admitted.length<limitChunks&&reserved+estimate(c)<=limitBytes){admitted.push(c);reserved+=estimate(c);}
    const keep=new Set(admitted.map(c=>c.key));lastView=keep;
    for(const [key,c] of pending)if(!keep.has(key))c.abort();
    const missingChunks=admitted.filter(c=>!cache.has(c.key)),missing=missingChunks.reduce((sum,c)=>sum+estimate(c),0);evict(keep,limitBytes-missing,limitChunks-missingChunks.length);
    if(admitted.length<chunks.length)drawCoverage();
    let shown=0,loaded=0;gl.uniform1f(u.coverage,0);
    for(const c of admitted){const x=cache.get(c.key);if(!x){if(active<2&&!pending.has(c.key)&&!failed.has(c.key))load(c,epoch);continue;}
      x.used=performance.now();loaded++;shown+=x.n;bind(x.gpu);gl.drawArrays(gl.LINES,0,x.nv);
    }
    evict(keep);
    message(chunks.length?`${fmt(shown)} cells in loaded spatial chunks · ${loaded}/${admitted.length} admitted chunks.${admitted.length<chunks.length?' Cache limit: zoom in to load all '+chunks.length+' intersecting chunks.':''} Gray: QC failures / unlinked.`:'This field is outside processed whole-cell coverage. Existing points remain CellSTP predictions.');
    canvas.dataset.loaded=loaded;canvas.dataset.needed=admitted.length;canvas.dataset.intersecting=chunks.length;canvas.dataset.cells=shown;canvas.dataset.cache=cache.size;
    canvas.dataset.cacheBytes=[...cache.values()].reduce((s,x)=>s+x.bytes,0);canvas.dataset.renderer='WebGL lines';
  }
  function estimate(c){return c.cache_bytes_includes_CPU_and_GPU?c.cache_bytes:c.decoded_bytes+2*(c.cache_bytes-c.decoded_bytes);}
  function bind(gpu){
    for(const [key,size,type] of [['xy',2,gl.FLOAT],['style',4,gl.UNSIGNED_BYTE],['values',3,gl.FLOAT]]){
      gl.bindBuffer(gl.ARRAY_BUFFER,gpu[key]);gl.enableVertexAttribArray(u[key]);gl.vertexAttribPointer(u[key],size,type,false,0,0);
    }
  }
  let coverage=null;
  function drawCoverage(){
    if(!coverage||coverage.epoch!==epoch){if(coverage?.gpu)dispose(coverage);const points=[];
      for(const f of index.coverage){const [a,b,c,d]=f;points.push(a,b,c,b,c,b,c,d,c,d,a,d,a,d,a,b);}
      coverage={epoch,xy:new Float32Array(points),style:new Uint8Array(points.length/2*4),values:new Float32Array(points.length/2*3)};upload(coverage);}
    gl.uniform1f(u.coverage,1);bind(coverage.gpu);gl.drawArrays(gl.LINES,0,coverage.xy.length/2);
  }
  function openRegion(id,move=true){
    const r=index?.regions.find(c=>c.id===id);if(!r)return;currentRegion=r;$('wc-region').value=id;
    const m=r.metrics||{};const lines=[r.label,r.control?'Prespecified image-only control; not pathology-negative gold.':'Previously detected candidate; pathology status unreviewed.'];
    const count=n=>Number.isFinite(n)?fmt(n):'Unavailable';
    if(!r.control)lines.push(`v15 T ${count(m.T)} · B ${count(m.B)} · ${fixed(m.area_mm2,3)} mm²`,
      `Lymphoid fraction ${fixed(m.lymphoid_fraction_score,1)}% · B/T zoning ${fixed(m.zoning_score,1)}/100`,
      `Usable whole-cell links ${fixed(m.quality_score,1)}% of original candidate nuclei`,
      `Composition: ${r.composition_type||'Unscored'}`,
      `Science stage: ${r.science?.stage||'Unassigned'} · model prediction`,
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
  const stageNames=['E','P','S','Unassigned'],stageColors=['#ce9237','#529ab9','#a061b6','#8a979e'];
  let tlsGeometry=null;
  function regionRings(r){return $('wc-tls-boundary').value==='refined'&&r.refined_rings?r.refined_rings:(r.raw_rings||r.rings||[]);}
  function tlsClass(r){return $('wc-tls-colour').value==='stage'?(r.science?.stage||'Unassigned'):(r.composition_type||'Unscored');}
  function renderTLSControls(){
    if(!index)return;const stage=$('wc-tls-colour').value==='stage',names=stage?stageNames:compNames,colors=stage?stageColors:compColors;
    const candidates=index.regions.filter(r=>!r.control),count=Object.fromEntries(names.map(n=>[n,candidates.filter(r=>tlsClass(r)===n).length]));
    $('wc-tls-filter').innerHTML='<option value="all">All candidate types</option>'+names.map(n=>`<option value="${escape(n)}">${escape(n)} · ${count[n]}</option>`).join('');
    text($('wc-tls-counts'),`${candidates.length} candidate regions · ${fixed(index.summary.candidate_area_mm2,2)} mm² total · ${fixed(index.summary.candidate_density,2)} candidates / mm² tissue`);
    $('wc-tls-legend').innerHTML=names.filter(n=>count[n]).map(n=>`<div class="wc-legend"><i style="background:${colors[names.indexOf(n)]}"></i>${escape(stage&&n!=='Unassigned'?n+'-TLS prediction':n)} <b>${count[n]}</b></div>`).join('');
  }
  function drawTLS(b){
    const stage=$('wc-tls-colour').value==='stage',names=stage?stageNames:compNames,colors=stage?stageColors:compColors,filter=$('wc-tls-filter').value;
    const selected=index.regions.filter(r=>!r.control&&(filter==='all'||tlsClass(r)===filter));
    if(!tlsGeometry){const xy=[],style=[],values=[];
      for(const r of selected)for(const ring of regionRings(r)){const li=Math.max(0,names.indexOf(tlsClass(r)));
        let along=0;for(let k=0;k<ring.length;k++){const p=ring[k],q=ring[(k+1)%ring.length],len=Math.hypot(q[0]-p[0],q[1]-p[1]);
          xy.push(...p,...q);style.push(li,li,1,0,li,li,1,0);values.push(along,stage&&r.science?.stable===false?1:0,0,along+len,stage&&r.science?.stable===false?1:0,0);along+=len;}}
      tlsGeometry={xy:new Float32Array(xy),style:new Uint8Array(style),values:new Float32Array(values)};upload(tlsGeometry);
    }
    const palette=Array.from({length:48},(_,i)=>colors[i]||'#889299').flatMap(c=>c.slice(1).match(/../g).map(x=>parseInt(x,16)/255));
    gl.uniform3fv(u.colors,new Float32Array(palette));gl.uniform1fv(u.enabled,new Float32Array(47).fill(1));gl.uniform1f(u.mode,1);gl.uniform1f(u.coverage,0);gl.uniform1f(u.failed,1);gl.uniform1f(u.tls,1);gl.uniform1f(u.unknown,1);
    bind(tlsGeometry.gpu);gl.drawArrays(gl.LINES,0,tlsGeometry.xy.length/2);
    const visible=selected.filter(r=>intersects(r.bounds,b));
    const annotated=visible.sort((a,z)=>(z.id===currentRegion?.id)-(a.id===currentRegion?.id)||(z.metrics?.area_mm2||0)-(a.metrics?.area_mm2||0)),boxes=[];
    for(const r of annotated){if(boxes.length>=8)break;const label=`${r.slide||S.slide} C${String(r.candidate_id).padStart(3,'0')} · ${tlsClass(r)}`;
      const w=Math.min(S.w-20,label.length*5.6+12),h=20,x=Math.max(w/2+5,Math.min(S.w-w/2-5,((r.bounds[0]+r.bounds[2])/2-S.cx)*S.scale+S.w/2)),y=Math.max(60,Math.min(S.h-25,((r.bounds[1]+r.bounds[3])/2-S.cy)*S.scale+S.h/2));
      const box=[x-w/2,y-h/2,x+w/2,y+h/2];if(boxes.some(b=>intersects(b,[box[0]-5,box[1]-5,box[2]+5,box[3]+5])))continue;
      const span=document.createElement('span');span.textContent=label;span.style.left=`${x}px`;span.style.top=`${y}px`;$('tls-labels').append(span);boxes.push(box);}
    message(`${visible.length} candidates intersect this view · ${selected.length}/${index.summary.candidates} selected on ${S.slide}. Click a contour to inspect composition and stage evidence.`);
    canvas.dataset.renderer='WebGL TLS contours';canvas.dataset.tlsVisible=visible.length;canvas.dataset.tlsSelected=selected.length;
  }
  function insideRing(x,y,ring){let inside=false;for(let i=0,j=ring.length-1;i<ring.length;j=i++){
    const [xi,yi]=ring[i],[xj,yj]=ring[j];if((yi>y)!==(yj>y)&&x<(xj-xi)*(y-yi)/(yj-yi)+xi)inside=!inside;}return inside;}
  function pickRegion(x,y){const filter=$('wc-tls-filter').value;
    const r=index?.regions.find(r=>!r.control&&(filter==='all'||tlsClass(r)===filter)&&x>=r.bounds[0]&&x<=r.bounds[2]&&y>=r.bounds[1]&&y<=r.bounds[3]&&
      regionRings(r).reduce((v,ring)=>v!==insideRing(x,y,ring),false));
    if(r)openRegion(r.id);return r||null;
  }
  function pick(x,y){
    if(!index||!$('wc-show').checked||!S.selected.size||S.clean||S.held)return null;let best=null,minimum=Infinity;
    for(const chunk of cache.values())for(let i=0;i<chunk.n;i++){
      const r=chunk.record(i),li=+$('wc-colour').value===1?r.cellstp:r.leaf;
      if((li<47&&!S.selected.has(li))||(li>46&&S.selected.size<47)||(!$('wc-failed').checked&&!(r.flags&1)))continue;
      const distance=Math.hypot((r.x-x)*S.meta.mpp[0],(r.y-y)*S.meta.mpp[1]);
      if(distance<minimum&&distance<=8){minimum=distance;best=r;best.chunk=chunk.key;best.chunkIndex=i;}
    }
    if(!best){text($('wc-cell-info'),'No linked whole-cell measurement is loaded at this position. Zoom into a processed region.');return null;}
    selected=best;renderCell(best);return best;
  }
  function renderCell(r){
    const li=r.leaf<47?taxonomy.labels[taxonomy.leaves[r.leaf]]:'Unlinked / unavailable';
    const old=r.cellstp<47?taxonomy.labels[taxonomy.leaves[r.cellstp]]:'Unlinked';const good=!!(r.flags&1);
    const values=manifest.features.map((key,i)=>({key,value:r.features[i]})).filter(x=>x.key in labels),stats=index.class_stats?.[taxonomy.leaves[r.leaf]];
    $('wc-cell-info').innerHTML=`<div class="cell-name">${escape(li)}</div><div class="cell-meta">NuClass v15 · ${Number.isFinite(r.p[0])?fixed(r.p[0]*100,1)+'% posterior':'no linked posterior'} · v6 geometry<br>Original CellSTP: ${escape(old)}<br>${good?'Complete single-nucleus geometry':'QC failure: inspect gray contour'} · ${r.nuclei} associated nuclei<br>Native identity link: ${r.row>=0?'unique nuclear match':'unmatched'}</div>
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
  canvas.addEventListener('webglcontextrestored',()=>{initGL();for(const x of cache.values())upload(x);coverage=null;tlsGeometry=null;request();});
  return {setSlide,draw,pick,pickRegion,openRegion,get state(){return {slide:S.slide,loaded:!!index,cache:cache.size,bytes:[...cache.values()].reduce((s,x)=>s+x.bytes,0),compressed:shardReader.state,regions:index?.regions.length||0,epoch,selected};},get manifest(){return manifest;},get index(){return index;},get cache(){return cache;}};
}
