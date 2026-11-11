# NuClass tissue reviewer

Embedded at `cell-tree/Nuclass_visual.html`; `index.html` is the full-window reviewer. The existing GitHub Pages deployment serves all assets directly. There is no application server, external image service, or model inference.

The default is S07, fine resolution, every one of the 47 leaf classes selected, and posterior support set to 0.00 (no cutoff). The restored slider covers 0.00–0.95 in 0.05 steps; increasing it rolls uncertain labels up to their supported ancestors without hiding cells. S03 is the only other sample. The original combined label **Carcinoma / generic epithelium** is included; it is not a malignancy-only annotation. The interface uses NuClass branding, and `data/manifest.json` retains the frozen export's source-model provenance.

## Delivery and interaction

- The first image is a small whole-slide preview; an all-cell raster appears while the compact coordinates load.
- Native-resolution image pyramids are fetched only for the visible field, with six concurrent image loads, asynchronous decoding, retained coarse levels and a bounded decoded-tile cache.
- Each sample's complete coordinate/leaf map loads once (S07 about 9.9 MB compressed; S03 about 3.0 MB). WebGL draws all cells at every zoom. There is no field-of-view cutoff or point subsampling. The Canvas2D fallback also retains all cells, but is slower on large views.
- An additional compact support map (S07 4.3 MB; S03 1.3 MB) loads in a Web Worker after the initial cell map. Slider decisions use the original float32 posterior with float64 subtree sums and exactly match the original 60 combinations of resolution and threshold. Rapid slider input is coalesced; only the latest worker result updates the GPU labels, legend, selected-cell text and CSV export.
- Panning/zooming updates through `requestAnimationFrame`. View counts are deferred until interaction settles. A spatial index limits cell picking to nearby chunks. Only the chosen cell's posterior shard is requested.
- Original/H&E and overlay share one coordinate transform. Wheel, trackpad pinch, touch pinch, drag, keyboard, navigator, saved fields, split, fullscreen and CSV exports are supported.
- A mobile layout places filters/settings in drawers. Error messages and retries handle unavailable cell/posterior data; the overview remains behind image tiles.

All 3,099,177 analysis-valid nuclei retain their original native coordinates and leaf calls (S07: 2,362,269; S03: 736,908). Carcinoma/generic epithelial counts are 349,386 and 270,860 respectively. Zero-count classes stay in the 47-class selector.

Images retain every pyramid level including native pixels, delivered with lossy AVIF Q45 (S07) and WebP Q70 (S03). They are web previews, not lossless research originals. The 47-class posterior is independently rounded to uint16/65535, with maximum absolute error 0.00000763; it is not renormalized. Labels and coordinates are not quantized. Downloads identify the posterior precision. Original source files are untouched.

## Rebuild and verify

Requirements: Python 3, numpy, Pillow, pillow-avif-plugin. From the repository root:

```sh
python3 scripts/build_nuclass_assets.py /path/to/CellSTP_CellType_Showcase_Complete
python3 scripts/verify_nuclass_assets.py
node --input-type=module --check < cell-tree/nuclass-reviewer/reviewer.js
node scripts/test_nuclass_resolution.mjs /path/to/CellSTP_CellType_Showcase_Complete
python3 -m http.server 8765 --bind 127.0.0.1
```

Open `http://localhost:8765/cell-tree/Nuclass_visual.html`. The builder verifies original leaf argmax and complete counts before writing output. The validator checks all coordinates, all posterior shards and every tile path. Existing tiles are reused; remove generated tiles before changing compression settings. `data/build-receipt.json` records output size and source-cell totals. Keep the entire published site below the GitHub Pages size limit; these assets are about 904 MB.

Manual browser checks: both slides at whole slide, 2 mm, 1 mm, 500 μm and native scale; posterior slider at 0, 0.75 and 0.95 across fine/lineage/broad; epithelial/immune/individual filters; cell selection and 47 probabilities; rapid sample switching; split/fullscreen; phone width; exports; error/retry behavior. Add `?debug=1` to the reviewer URL to expose CPU draw time, cell count, renderer and tile-cache size as data attributes on `#reviewer` (CPU time is not an FPS measurement).
