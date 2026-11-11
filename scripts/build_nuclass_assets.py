"""Build a static, native-resolution S07/S03 web showcase from the frozen export.
Requires Python 3, numpy, Pillow and pillow-avif-plugin. No model inference.
Usage: python scripts/build_nuclass_assets.py /path/to/CellSTP_CellType_Showcase_Complete
"""
import argparse, base64, gzip, hashlib, json, math, pathlib, shutil, time
from concurrent.futures import ThreadPoolExecutor
import numpy as np
from PIL import Image
from build_nuclass_support import build_support
import pillow_avif  # registers AVIF with Pillow


def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, separators=(',', ':')))


def compress(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(gzip.compress(data, compresslevel=6, mtime=0))


def convert_tile(job):
    source, target = job
    if target.exists():
        return target.stat().st_size
    target.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(source) as im:
        if target.suffix == '.webp':
            im.convert('RGB').save(target, 'WEBP', quality=70, method=4)
        else:
            im.convert('RGB').save(target, 'AVIF', quality=45, speed=8, max_threads=1)
    return target.stat().st_size


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('source', type=pathlib.Path)
    ap.add_argument('--output', type=pathlib.Path, default=pathlib.Path('cell-tree/nuclass-reviewer/data'))
    ap.add_argument('--workers', type=int, default=6)
    args = ap.parse_args()
    src, out = args.source, args.output
    out.mkdir(parents=True, exist_ok=True)
    taxonomy = json.loads((src/'data/TAXONOMY.json').read_text())
    cohort = json.loads((src/'data/COHORT.json').read_text())
    fields = json.loads((src/'data/FIELDS.json').read_text())
    manifest = {'name':'NuClass', 'version':1, 'slides':[], 'taxonomy':{k:taxonomy[k] for k in ['leaves','nodes','parents','members','labels','colors','cuts','paths']},
                'probabilityEncoding':{'type':'uint16','divisor':65535,'maxAbsoluteError':0.5/65535},
                'provenance':{'sourceModel':taxonomy['model'], 'sourceTaxonomySHA256':hashlib.sha256((src/'data/TAXONOMY.json').read_bytes()).hexdigest(), 'newInference':False,
                'imageEncoding':'S07 AVIF Q45; S03 WebP Q70. Every original pyramid level retained, including native pixels. Lossy web delivery.',
                'cellPolicy':'All original analysis-valid nuclei; all 47 leaf types; no confidence threshold or point subsampling. Leaf calls unchanged.',
                'probabilityPolicy':'Original 47-class probabilities rounded independently to unsigned 16-bit values (max absolute error 0.00000763). No renormalization.'}}
    # A stronger epithelial accent makes carcinoma visible against H&E.
    manifest['taxonomy']['colors']['Carcinoma_or_other_epithelial'] = '#ee7b31'
    manifest['taxonomy']['colors']['Epithelial'] = '#ee7b31'
    jobs = []
    for sid in ['S07','S03']:
        start = time.time()
        meta = json.loads((src/f'data/SLIDE_{sid}.json').read_text())
        summary = next(s for s in cohort['slides'] if s['id']==sid)
        target = out/sid
        target.mkdir(exist_ok=True)
        positions, leaves, chunks, n = [], [], [], 0
        hist = np.zeros(47, dtype=np.int64)
        for c in meta['chunks']:
            raw_text = (src/f'assets/slides/{sid}/cells/{c["key"]}.js').read_text()
            raw = base64.b64decode(json.loads('['+raw_text.split('(',1)[1].rsplit(')',1)[0]+']')[2])
            assert len(raw)==c['count']*208
            words = np.frombuffer(raw, '<u4').reshape(-1,52)
            bytes_ = np.frombuffer(raw, 'u1').reshape(-1,208)
            valid = bytes_[:,10].astype(bool)
            xy = words[valid,:2].astype('<f4')
            leaf = bytes_[valid,9].copy()
            prob = np.frombuffer(raw, '<f4').reshape(-1,52)[valid,5:]
            assert np.all(leaf==prob.argmax(axis=1))
            q = np.rint(np.clip(prob.astype(np.float64),0,1)*65535).astype('<u2')
            if len(leaf):
                compress(target/'probabilities'/f'{c["key"]}.bin.gz', q.tobytes())
                chunks.append({'key':c['key'],'start':n,'count':len(leaf),'x':c['x'],'y':c['y']})
                n += len(leaf)
                positions.append(xy)
                leaves.append(leaf)
                hist += np.bincount(leaf,minlength=47)
        assert n==meta['valid']==summary['valid']
        assert hist.tolist()==summary['counts'][2][0][:47]
        # Header: uint32 count, then interleaved float32 x/y, then uint8 leaf.
        payload = np.array([n],dtype='<u4').tobytes()+np.concatenate(positions).tobytes()+np.concatenate(leaves).tobytes()
        compress(target/'cells.bin.gz',payload)
        shutil.copyfile(src/meta['overview'],target/'overview.jpg')
        # A small all-cell raster gives immediate visual feedback before GPU data arrives.
        xy=np.concatenate(positions); leaf=np.concatenate(leaves)
        scale=2048/max(meta['width'],meta['height'])
        w,h=round(meta['width']*scale),round(meta['height']*scale)
        preview=np.zeros((h,w,4),dtype=np.uint8)
        palette=np.array([list(bytes.fromhex(manifest['taxonomy']['colors'][node][1:]))+[255] for node in taxonomy['leaves']],dtype=np.uint8)
        x=np.clip((xy[:,0]*scale).astype(int),0,w-1); y=np.clip((xy[:,1]*scale).astype(int),0,h-1)
        preview[y,x]=palette[leaf]
        Image.fromarray(preview).save(target/'overlay-fine.webp',lossless=True,method=4)
        slide = {k:meta[k] for k in ['id','case','width','height','mpp','levels','tile_size','cell_chunk_px','queries','valid']}
        slide.update({'tile_ext':'avif' if sid=='S07' else 'webp','counts':hist.tolist(),'chunks':chunks,'fields':[{k:f[k] for k in ['id','label','origin','width','height','selected','kind']} for f in fields if f['slide']==sid]})
        write_json(target/'slide.json',slide)
        manifest['slides'].append({k:slide[k] for k in ['id','case','width','height','mpp','valid','counts']})
        for path in sorted((src/f'assets/slides/{sid}/tiles').rglob('*')):
            if path.is_file(): jobs.append((path,target/'tiles'/path.relative_to(src/f'assets/slides/{sid}/tiles').with_suffix('.avif' if sid=='S07' else '.webp')))
        print(f'{sid}: verified {n:,} nuclei, carcinoma/epithelium {hist[0]:,}; compact data ready in {time.time()-start:.1f}s',flush=True)
    write_json(out/'manifest.json',manifest)
    start=time.time(); total=0
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        for i,size in enumerate(pool.map(convert_tile,jobs),1):
            total+=size
            if i%500==0 or i==len(jobs):print(f'Tiles {i}/{len(jobs)} · {total/1e6:.1f} MB · {time.time()-start:.0f}s',flush=True)
    build_support(src,out)
    receipt={'slides':{s['id']:s['valid'] for s in manifest['slides']},'tiles':len(jobs),'tileBytes':total,'totalBytes':sum(p.stat().st_size for p in out.rglob('*') if p.is_file())}
    write_json(out/'build-receipt.json',receipt)
    print(json.dumps(receipt),flush=True)

if __name__=='__main__':main()
