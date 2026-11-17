// An independently versioned boundary layer over the immutable v6 analyses.
export function applyTLSBoundaries(index, payload, manifest) {
  const sid=index.slide, candidates=index.regions.filter(r=>!r.control);
  if(payload.version!==2 || payload.slide!==sid || payload.data_revision!==manifest.data_revision ||
    payload.source_index_sha256!==manifest.remote_indexes?.[sid]?.sha256 ||
    JSON.stringify(payload.mpp)!==JSON.stringify(index.mpp)) throw Error('TLS boundary source mismatch');
  const byID=new Map(payload.regions.map(r=>[r.id,r]));
  if(byID.size!==payload.regions.length || byID.size!==candidates.length) throw Error('TLS candidate count mismatch');
  for(const r of candidates) {
    const b=byID.get(r.id), ring=b?.rings?.[0];
    if(!b || b.rings.length!==1 || !Array.isArray(ring) || ring.length<4 ||
      ring.some(p=>!Array.isArray(p)||p.length!==2||!p.every(Number.isFinite)) ||
      ring[0][0]!==ring.at(-1)[0] || ring[0][1]!==ring.at(-1)[1] ||
      b.audit?.id!==r.id || b.audit.holes!==0 || b.audit.components!==1 ||
      !Array.isArray(b.bounds) || b.bounds.length!==4 || !b.bounds.every(Number.isFinite) ||
      ring.some(([x,y])=>x<b.bounds[0]||x>b.bounds[2]||y<b.bounds[1]||y>b.bounds[3]))
      throw Error(`Invalid continuous TLS boundary: ${r.id}`);
  }
  // Validate everything before applying; never leave a partially revised slide.
  for(const r of candidates) r.continuous_boundary=byID.get(r.id);
  return index;
}

export async function loadTLSBoundaries(index, manifest, base, signal) {
  const get=async path=>{const r=await fetch(new URL(path,base),{signal});if(!r.ok)throw Error(`TLS boundaries unavailable (${r.status})`);return r;};
  const catalog=await (await get('TLS_BOUNDARIES_V2.json?v=2')).json();
  const file=catalog.files?.[index.slide];
  if(catalog.version!==2 || catalog.data_revision!==manifest.data_revision ||
    file?.file!==`${index.slide}/tls-boundaries-v2.json`) throw Error('TLS boundary revision mismatch');
  const bytes=await (await get(`${file.file}?v=${file.sha256}`)).arrayBuffer();
  if(bytes.byteLength!==file.bytes) throw Error('TLS boundary length mismatch');
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),v=>v.toString(16).padStart(2,'0')).join('');
  if(hash!==file.sha256) throw Error('TLS boundary integrity mismatch');
  return applyTLSBoundaries(index,JSON.parse(new TextDecoder().decode(bytes)),manifest);
}

export function tlsRings(region, mode) {
  if(mode==='continuous' && region.continuous_boundary) return region.continuous_boundary.rings;
  if(mode!=='raw' && region.refined_rings) return region.refined_rings;
  return region.raw_rings||region.rings||[];
}

export function tlsBounds(region, mode) {
  if(mode==='continuous' && region.continuous_boundary) return region.continuous_boundary.bounds;
  return region.bounds;
}
