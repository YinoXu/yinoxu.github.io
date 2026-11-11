"""Compact exact support decisions from the original float32 posteriors.
No images are rebuilt. Each byte is the highest supported slider step for a
node on a cell's original leaf-to-root path. Validate all 60 display settings.
"""
import argparse, base64, gzip, json, pathlib
import numpy as np


def build_support(source, output):
    tax=json.loads((source/'data/TAXONOMY.json').read_text())
    cohort=json.loads((source/'data/COHORT.json').read_text())
    nodes=tax['nodes']; slots=max(map(len,tax['paths']['fine'])); steps=np.arange(20,dtype='f8')/20
    paths=np.full((47,slots),nodes.index('All'),dtype='u1')
    for li,path in enumerate(tax['paths']['fine']): paths[li,:len(path)]=[nodes.index(n) for n in path]
    starts={mode:np.array([tax['paths']['fine'][li].index(tax['paths'][mode][li][0]) for li in range(47)],dtype='u1') for mode in ['broad','lineage','fine']}
    receipt={}
    for sid in ['S07','S03']:
        meta=json.loads((output/sid/'slide.json').read_text()); buffers=[]; leaves=[]
        original_meta=json.loads((source/f'data/SLIDE_{sid}.json').read_text())
        for c in original_meta['chunks']:
            text=(source/f'assets/slides/{sid}/cells/{c["key"]}.js').read_text()
            raw=base64.b64decode(json.loads('['+text.split('(',1)[1].rsplit(')',1)[0]+']')[2])
            b=np.frombuffer(raw,'u1').reshape(-1,208); valid=b[:,10].astype(bool); leaf=b[valid,9]
            if not len(leaf):continue
            p=np.frombuffer(raw,'<f4').reshape(-1,52)[valid,5:]
            caps=np.full((len(leaf),len(nodes)),19,dtype='u1')
            for ni in np.unique(paths[leaf]):
                name=nodes[ni]
                if name=='All':continue
                mass=p[:,tax['members'][name]].sum(axis=1,dtype='f8')
                caps[:,ni]=np.searchsorted(steps,mass,side='right')-1
            buffers.append(caps[np.arange(len(leaf))[:,None],paths[leaf]])
            leaves.append(leaf)
        support=np.concatenate(buffers); leaf=np.concatenate(leaves)
        assert len(leaf)==meta['valid']
        packed=gzip.decompress((output/sid/'cells.bin.gz').read_bytes())
        assert np.array_equal(leaf,np.frombuffer(packed,'u1',offset=4+len(leaf)*8))
        expected=next(s['counts'] for s in cohort['slides'] if s['id']==sid)
        # Compare every threshold and resolution with the original full-slide counts.
        row=np.arange(len(leaf)); ownpaths=paths[leaf]
        for mi,mode in enumerate(['broad','lineage','fine']):
            start=starts[mode][leaf]
            for ti in range(20):
                idx=start.copy()
                for _ in range(slots-1):idx+=support[row,idx]<ti
                labels=ownpaths[row,idx]
                actual=np.bincount(labels,minlength=len(nodes)).tolist()
                assert actual==expected[mi][ti],(sid,mode,ti)
        payload=np.array([len(leaf),slots],dtype='<u4').tobytes()+support.tobytes()
        target=output/sid/'support.bin.gz'; target.write_bytes(gzip.compress(payload,compresslevel=6,mtime=0))
        receipt[sid]={'cells':len(leaf),'settingsVerified':60,'compressedBytes':target.stat().st_size}
        print(sid,receipt[sid],flush=True)
    path=output/'manifest.json'; manifest=json.loads(path.read_text())
    manifest['supportEncoding']={'pathSlots':slots,'thresholds':steps.tolist(),'source':'Original float32 posteriors, float64 subtree sums; exact original slider decisions.'}
    manifest['provenance']['cellPolicy']='All original analysis-valid nuclei; all 47 leaf types; default support 0. Optional posterior support rolls labels up their original path; no cell is removed or subsampled.'
    path.write_text(json.dumps(manifest,separators=(',',':')))
    (output/'support-receipt.json').write_text(json.dumps(receipt,separators=(',',':')))
    build_receipt=output/'build-receipt.json'
    if build_receipt.exists():
        info=json.loads(build_receipt.read_text()); info['totalBytes']=sum(p.stat().st_size for p in output.rglob('*') if p.is_file())
        build_receipt.write_text(json.dumps(info,separators=(',',':')))
    return receipt

if __name__=='__main__':
    ap=argparse.ArgumentParser();ap.add_argument('source',type=pathlib.Path);ap.add_argument('--output',type=pathlib.Path,default=pathlib.Path('cell-tree/nuclass-reviewer/data'));args=ap.parse_args()
    build_support(args.source,args.output)
