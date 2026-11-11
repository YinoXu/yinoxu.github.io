"""Validate static viewer assets, including every cell, posterior shard and tile path."""
import gzip, json, math, pathlib
import numpy as np

root=pathlib.Path(__file__).resolve().parents[1]/'cell-tree/nuclass-reviewer/data'
manifest=json.loads((root/'manifest.json').read_text())
assert [s['id'] for s in manifest['slides']]==['S07','S03']
assert len(manifest['taxonomy']['leaves'])==47
results=[]
for summary in manifest['slides']:
    sid=summary['id'];base=root/sid;meta=json.loads((base/'slide.json').read_text())
    raw=gzip.decompress((base/'cells.bin.gz').read_bytes());n=int(np.frombuffer(raw,'<u4',count=1)[0])
    assert n==summary['valid']==meta['valid'] and len(raw)==4+n*9
    xy=np.frombuffer(raw,'<f4',offset=4,count=n*2).reshape(-1,2)
    leaf=np.frombuffer(raw,'u1',offset=4+n*8,count=n)
    assert np.all(np.isfinite(xy)) and np.all(xy==np.floor(xy))
    assert np.all(xy>=0) and np.all(xy[:,0]<meta['width']) and np.all(xy[:,1]<meta['height'])
    assert np.bincount(leaf,minlength=47).tolist()==summary['counts']==meta['counts']
    offset=0
    for c in meta['chunks']:
        assert c['start']==offset
        q=np.frombuffer(gzip.decompress((base/'probabilities'/f'{c["key"]}.bin.gz').read_bytes()),'<u2').reshape(-1,47)
        assert len(q)==c['count']
        # Independent rounding can differ in mass by at most 47 half-steps.
        assert np.max(np.abs(q.astype(float).sum(axis=1)/65535-1))<47/65535
        points=xy[offset:offset+c['count']]
        assert np.all((points//meta['cell_chunk_px']).astype(int)==[c['x'],c['y']])
        offset+=c['count']
    assert offset==n
    tiles=0
    for level in meta['levels']:
        for y in range(math.ceil(level['height']/meta['tile_size'])):
            for x in range(math.ceil(level['width']/meta['tile_size'])):
                path=base/'tiles'/str(level['level'])/f'{x}_{y}.{meta["tile_ext"]}'
                assert path.is_file() and path.stat().st_size>0, path
                tiles+=1
    assert (base/'overview.jpg').is_file() and (base/'overlay-fine.webp').is_file()
    results.append({'slide':sid,'cells':n,'carcinoma_epithelium':int(summary['counts'][0]),'posterior_shards':len(meta['chunks']),'tiles':tiles})
files=[p for p in root.rglob('*') if p.is_file()]
assert max(p.stat().st_size for p in files)<100_000_000
size=sum(p.stat().st_size for p in files)
assert size<950_000_000
print(json.dumps({'verified':results,'files':len(files),'assetBytes':size},indent=2))
