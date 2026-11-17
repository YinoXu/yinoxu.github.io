# NuClass tissue reviewer

Embedded at `cell-tree/Nuclass_visual.html`; `index.html` is the full-window reviewer. GitHub Pages serves the interface and existing H&E tiles. Full-slide masks and v15 point data stream from a pinned immutable GitHub data commit. There is no application server, external image service, or model inference.

The default is S07, fine resolution, every one of the 47 leaf classes selected, and posterior support set to 0.00 (no cutoff). The restored slider covers 0.00–0.95 in 0.05 steps; increasing it rolls uncertain labels up to their supported ancestors without hiding cells. S03 is the only other sample. The original combined label **Carcinoma / generic epithelium** is included; it is not a malignancy-only annotation. The interface uses NuClass branding, and `data/manifest-v15.json` identifies the default NuClass v15 checkpoint (step 59712). `data/manifest.json` and the original point files retain historical CellSTP provenance.

## Delivery and interaction

- The first image is a small whole-slide preview; an all-cell raster appears while the compact coordinates load.
- Native-resolution image pyramids are fetched only for the visible field, with six concurrent image loads, asynchronous decoding, retained coarse levels and a bounded decoded-tile cache.
- Each sample's complete v15 coordinate/leaf map loads once in SHA-256-verified compressed parts. WebGL draws all cells at every zoom. There is no field-of-view cutoff or point subsampling. The Canvas2D fallback also retains all cells, but is slower on large views.
- An additional compact v15 support map loads in a Web Worker after the initial cell map. Slider decisions use the original float32 posterior with float64 subtree sums and exactly match the original 60 combinations of resolution and threshold. Rapid slider input is coalesced; only the latest worker result updates the GPU labels, legend, selected-cell text and CSV export.
- Panning/zooming updates through `requestAnimationFrame`. View counts are deferred until interaction settles. A spatial index limits cell picking to nearby chunks. Only the chosen cell's posterior shard is requested.
- Original/H&E and overlay share one coordinate transform. Wheel, trackpad pinch, touch pinch, drag, keyboard, navigator, saved fields, split, fullscreen and CSV exports are supported.
- A mobile layout places filters/settings in drawers. Error messages and retries handle unavailable cell/posterior data; the overview remains behind image tiles.

All 3,099,177 analysis-valid nuclei retain their original native coordinates (S07: 2,362,269; S03: 736,908). Default leaf calls, counts, 47-class posteriors and support rollups now come from frozen NuClass v15. Zero-count classes stay in the 47-class selector. The historical calls remain unchanged in their original files.

Whole-cell v6 segmentation covers all 35,117 grid fields, with 3,898,267 raw predicted instances. A discrete multiresolution atlas shows complete viewports at low zoom; original integer contours load at high zoom. Nuclear and whole-cell fills/outlines are independent. Glass-background predictions are hidden by a documented tissue filter and can be inspected with the raw-background toggle. This is a display policy, not a model accuracy improvement. TLS analyses retain their original 189 candidates and frozen evidence.

Images retain every pyramid level including native pixels, delivered with lossy AVIF Q45 (S07) and WebP Q70 (S03). They are web previews, not lossless research originals. The 47-class posterior is independently rounded to uint16/65535, with maximum absolute error 0.00000763; it is not renormalized. Labels and coordinates are not quantized. Downloads identify the posterior precision. Original source files are untouched.

## Release and verify

The full-slide release binds `wholecell/manifest-v6.json`, `data/manifest-v15.json` and `wholecell/{S03,S07}/analysis-v6.json` to one verified data commit. Run `python3 scripts/prepare_nuclass_release.py --release-root /path/to/frozen/release/root --data-commit <40-character-SHA>` only after that commit contains all 889 full-slide files and the frozen point files. Keep large data on the data branch, outside the Pages deployment. The script consumes existing verification receipts and does not run inference. `wholecell/FULLSLIDE_PROVENANCE.json` records coverage, checkpoint hashes and limitations.

Run `node scripts/test_nuclass_v15.mjs /path/to/data-checkout /path/to/V15_POINT_ROLLUP_EXPECTED.json` to compare the shipped loaders and all 60 settings to the independent frozen oracle. Run `node scripts/test_wholecell_geometry.mjs` and browser-check both slides, native contours and mask atlas, point posteriors, 60 support/resolution settings, combined layers, backgrounds, exports and mobile drawers.

## Historical H&E / CellSTP rebuild

The following commands rebuild or check the preserved original assets; they do not generate v15 predictions.

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
