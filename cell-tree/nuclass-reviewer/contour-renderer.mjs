// Batch lines and hole-aware triangles into screen masks. One GPU compositing
// pass controls outline width without per-segment draw calls or instances.
export function createContourRenderer(gl,state){
  const compile=(type,source)=>{const s=gl.createShader(type);gl.shaderSource(s,source);gl.compileShader(s);if(!gl.getShaderParameter(s,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(s));return s;};
  function program(vertex,fragment,names,uniforms){const p=gl.createProgram();gl.attachShader(p,compile(gl.VERTEX_SHADER,vertex));gl.attachShader(p,compile(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(p);if(!gl.getProgramParameter(p,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(p));
    const a={},u={};for(const n of names)a[n]=gl.getAttribLocation(p,'a_'+n);for(const n of uniforms)u[n]=gl.getUniformLocation(p,'u_'+n);return {p,a,u};}
  const vertex=`precision highp float;attribute vec2 a_xy;attribute vec4 a_style,a_values;
    uniform vec2 u_center,u_view,u_origin,u_units,u_parts;uniform float u_scale,u_mode,u_failed,u_unknown,u_alpha;
    uniform vec3 u_colors[48];uniform float u_enabled[47];varying mediump vec4 v_color;varying mediump float v_dash;
    void main(){vec2 p=(u_origin+a_xy*u_units-u_center)*u_scale/u_view*2.;gl_Position=vec4(p.x,-p.y,0.,1.);
      int li=int(u_mode<.5?a_style.x:a_style.y);float visible=1.;
      if(mod(a_style.w,2.)<.5?u_parts.x<.5:u_parts.y<.5)visible=0.;
      if(a_style.z<.5&&u_failed<.5)visible=0.;if(li>46&&u_unknown<.5)visible=0.;if(li<47&&u_enabled[li]<.5)visible=0.;
      vec3 c=u_colors[int(min(float(li),47.))];float alpha=u_alpha;
      if(u_mode>1.5){float t=u_mode<2.5?a_values.x:(u_mode<3.5?a_values.y:a_values.z);c=mix(vec3(.04,.7,.65),vec3(.68,.08,.82),t);}
      if(a_style.z<.5||li>46){c=vec3(.45,.50,.55);alpha*=.65;}
      if(visible<.5)gl_Position=vec4(3.,3.,0.,1.);v_color=vec4(c,alpha*visible);v_dash=a_values.w;
    }`;
  const fragment=`precision mediump float;varying mediump vec4 v_color;varying mediump float v_dash;uniform float u_dpr;void main(){if(v_color.a<.005)discard;if(v_dash>.5&&mod((gl_FragCoord.x+gl_FragCoord.y)/u_dpr,12.)<4.)discard;gl_FragColor=v_color;}`;
  const geometry=program(vertex,fragment,['xy','style','values'],['center','view','origin','units','parts','scale','mode','failed','unknown','alpha','colors','enabled','dpr']);
  const composite=program(`attribute vec2 a_xy;varying highp vec2 v_uv;void main(){gl_Position=vec4(a_xy,0.,1.);v_uv=a_xy*.5+.5;}`,
    `precision highp float;varying highp vec2 v_uv;uniform sampler2D u_lines,u_fills;uniform vec2 u_pixel;
     uniform float u_radius,u_halo,u_halo_radius;
     vec4 expand(float radius){vec4 c=texture2D(u_lines,v_uv);
       for(int ring=1;ring<=3;ring++){float r=radius*float(ring)/3.;
         for(int direction=0;direction<8;direction++){float angle=float(direction)*.7853981634;
           vec4 t=texture2D(u_lines,v_uv+vec2(cos(angle),sin(angle))*u_pixel*r);if(t.a>c.a)c=t;}}
       return c;
     }
     void main(){vec4 f=texture2D(u_fills,v_uv),s=expand(u_radius);
       if(u_halo>.5){float h=expand(u_halo_radius).a;vec4 white=vec4(vec3(h),h);f=white+f*(1.-white.a);}
       vec4 outColor=s+f*(1.-s.a);gl_FragColor=outColor.a>.0001?vec4(outColor.rgb/outColor.a,outColor.a):vec4(0.);
     }`,['xy'],['lines','fills','pixel','radius','halo','halo_radius']);
  const quad=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,quad);gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const allAttributes=new Set([...Object.values(geometry.a),...Object.values(composite.a)]);let size='',targets=null;
  const blend=()=>{gl.enable(gl.BLEND);gl.blendFuncSeparate(gl.SRC_ALPHA,gl.ONE_MINUS_SRC_ALPHA,gl.ONE,gl.ONE_MINUS_SRC_ALPHA);};blend();
  function target(width,height){const texture=gl.createTexture();gl.bindTexture(gl.TEXTURE_2D,texture);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    const framebuffer=gl.createFramebuffer();gl.bindFramebuffer(gl.FRAMEBUFFER,framebuffer);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,texture,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('Contour screen buffer unavailable');return {texture,framebuffer};}
  function ensure(){const width=gl.drawingBufferWidth,height=gl.drawingBufferHeight,key=width+'x'+height;if(key===size)return;size=key;
    if(targets)for(const x of Object.values(targets)){gl.deleteTexture(x.texture);gl.deleteFramebuffer(x.framebuffer);}targets={lines:target(width,height),fills:target(width,height)};}
  function reset(){for(const a of allAttributes)if(a>=0)gl.disableVertexAttribArray(a);}
  function attribute(index,count,type,normalized,stride,offset){if(index<0)return;gl.enableVertexAttribArray(index);gl.vertexAttribPointer(index,count,type,normalized,stride,offset);}
  function upload(g,{discardCPU=false}={}){
    const raw=g.lines instanceof ArrayBuffer?new Uint8Array(g.lines):g.lines,coordinate=g.compact?4:8,stride=coordinate+8,lines=new Uint8Array(g.lineCount*2*stride);
    for(let i=0;i<g.lineCount;i++)for(let end=0;end<2;end++){const from=i*g.lineStride,to=(i*2+end)*stride;lines.set(raw.subarray(from+end*coordinate,from+(end+1)*coordinate),to);lines.set(raw.subarray(from+coordinate*2,from+coordinate*2+8),to+coordinate);}
    const gpu={};for(const [key,data] of [['lines',lines],['fills',g.fills]]){const b=gl.createBuffer();gl.bindBuffer(gl.ARRAY_BUFFER,b);gl.bufferData(gl.ARRAY_BUFFER,data,gl.STATIC_DRAW);gpu[key]=b;}
    const result={...g,gpu,lineStride:stride,lineVertices:g.lineCount*2,gpuBytes:lines.byteLength+g.fills.byteLength};if(discardCPU){delete result.lines;delete result.fills;delete result.buffer;}return result;
  }
  function dispose(g){if(g?.gpu)for(const b of Object.values(g.gpu))gl.deleteBuffer(b);}
  function draw(g,o,kind){if(!g||(kind==='fills'&&!g.fillCount)||(kind==='lines'&&!g.lineCount))return;ensure();reset();blend();gl.bindFramebuffer(gl.FRAMEBUFFER,targets[kind].framebuffer);gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);gl.useProgram(geometry.p);
    const {u,a}=geometry;gl.uniform2f(u.center,state.cx,state.cy);gl.uniform2f(u.view,state.w,state.h);gl.uniform1f(u.scale,state.scale);gl.uniform2fv(u.origin,g.origin);gl.uniform2fv(u.units,g.units);
    gl.uniform2fv(u.parts,kind==='fills'?o.fillParts:o.parts||[1,1]);gl.uniform1f(u.alpha,kind==='fills'?o.fillAlpha??.3:o.alpha??.95);gl.uniform1f(u.mode,o.mode||0);gl.uniform1f(u.failed,o.failed===false?0:1);gl.uniform1f(u.unknown,o.unknown===false?0:1);gl.uniform3fv(u.colors,o.palette);gl.uniform1fv(u.enabled,o.enabled);gl.uniform1f(u.dpr,state.dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER,g.gpu[kind]);const stride=kind==='fills'?g.fillStride:g.lineStride,offset=g.compact?4:8;
    attribute(a.xy,2,g.compact?gl.UNSIGNED_SHORT:gl.FLOAT,false,stride,0);attribute(a.style,4,gl.UNSIGNED_BYTE,false,stride,offset);attribute(a.values,4,gl.UNSIGNED_BYTE,true,stride,offset+4);
    gl.drawArrays(kind==='fills'?gl.TRIANGLES:gl.LINES,0,kind==='fills'?g.fillCount:g.lineVertices);
  }
  function clear(){ensure();gl.clearColor(0,0,0,0);for(const x of Object.values(targets)){gl.bindFramebuffer(gl.FRAMEBUFFER,x.framebuffer);gl.clear(gl.COLOR_BUFFER_BIT);}gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);gl.clear(gl.COLOR_BUFFER_BIT);}
  function present(o){ensure();reset();gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.viewport(0,0,gl.drawingBufferWidth,gl.drawingBufferHeight);gl.disable(gl.BLEND);gl.useProgram(composite.p);
    for(const [unit,key] of ['lines','fills'].entries()){gl.activeTexture(gl.TEXTURE0+unit);gl.bindTexture(gl.TEXTURE_2D,targets[key].texture);gl.uniform1i(composite.u[key],unit);}
    gl.uniform2f(composite.u.pixel,1/gl.drawingBufferWidth,1/gl.drawingBufferHeight);const radius=Math.max(0,((o.width||2)*state.dpr-1)/2);gl.uniform1f(composite.u.radius,radius);gl.uniform1f(composite.u.halo,o.halo?1:0);gl.uniform1f(composite.u.halo_radius,radius+state.dpr);
    gl.bindBuffer(gl.ARRAY_BUFFER,quad);attribute(composite.a.xy,2,gl.FLOAT,false,0,0);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);blend();
  }
  return {upload,dispose,clear,present,filled(g,o){if(o.fillParts?.some(Boolean))draw(g,o,'fills');},stroke(g,o,override=0){if(!override)draw(g,o,'lines');}};
}
export function ringsGeometry(rings,{leaf=0,cellstp=leaf,dash=false}={}){
  const count=rings.reduce((n,r)=>n+r.xy.length,0),lines=new ArrayBuffer(count*24),d=new DataView(lines);let i=0;
  for(const r of rings)for(let j=0;j<r.xy.length;j++){const a=r.xy[j],b=r.xy[(j+1)%r.xy.length],o=i++*24;for(const [k,v] of [...a,...b].entries())d.setFloat32(o+k*4,v,true);d.setUint8(o+16,r.leaf??leaf);d.setUint8(o+17,r.leaf??cellstp);d.setUint8(o+18,1);d.setUint8(o+19,r.kind||0);d.setUint8(o+23,(r.dash??dash)?255:0);}
  return {lines,fills:new ArrayBuffer(0),lineCount:count,fillCount:0,lineStride:24,fillStride:16,origin:[0,0],units:[1,1],compact:false};
}
