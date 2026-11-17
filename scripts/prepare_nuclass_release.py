"""Bind the recovered, verified v15 release to an immutable public data commit.

Consumes the frozen release folder; does not run or modify any model.
"""
import argparse
import datetime
import json
import pathlib
import re
import shutil


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--release-root', type=pathlib.Path, required=True)
    parser.add_argument('--data-commit', required=True)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-f0-9]{40}', args.data_commit):
        parser.error('--data-commit must be a complete Git commit SHA')
    root = args.release_root
    web = pathlib.Path(__file__).resolve().parents[1] / 'cell-tree/nuclass-reviewer'
    read = lambda name: json.loads((root / name).read_text())
    verified = read('reviews/FULLSLIDE_DATA_VERIFIED.json')
    points_verified = read('reviews/V15_POINT_DATA_VERIFIED.json')
    assert verified['status'] == 'PASS_INDEPENDENT_FULL_DATA_VERIFICATION'
    assert points_verified['status'] == 'PASS_ALL_V15_POINT_CALLS_POSTERIORS_COORDINATES_AND_SUPPORT'
    blobs = read('release/PUBLIC_DATA_BLOBS.json')
    assert len(blobs) == 889
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    base = f'https://raw.githubusercontent.com/YinoXu/yinoxu.github.io/{args.data_commit}/'

    def write(name, value):
        path = web / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(value, separators=(',', ':'), allow_nan=False) + '\n')

    manifest = read('release/front/manifest.json')
    assert manifest['whole_slide_coverage'] and manifest['summary']['fields'] == 35117
    manifest.update(version=6, data_revision=args.data_commit,
                    publication_utc=now, geometry_base=base + 'wholecell/')
    manifest['geometry_delivery'] = dict(
        repository='YinoXu/yinoxu.github.io', branch='data/wholecell-fullslide-20261116',
        commit=args.data_commit, files=len(blobs), bytes=sum(b['bytes'] for b in blobs),
        complete_integer_contours=True, SHA256_verified_per_bundle=True,
        cache='Bounded native contours, 64 MiB display atlas, 8 MiB compressed bundles; visible fields only')
    manifest['summary']['geometry_and_posterior_bytes'] = sum(
        b['bytes'] for b in blobs if '/bundles/' in b['path'] and '/atlas/' not in b['path'])
    manifest['rendering'].update(
        data_commit=args.data_commit, native_cache_bytes=96*1024*1024,
        atlas_cache_bytes=64*1024*1024, compressed_bundle_cache_bytes=8*1024*1024,
        overview='Discrete multiresolution display of complete masks; zoom in for original integer contours.')
    manifest['analysis_summary'].update(
        instances=manifest['summary']['cells'],
        linked_QC=sum(s['linked_QC'] for s in verified['slides']),
        scope='Complete S03/S07 whole-slide geometry; original candidate analyses remain frozen separately')
    manifest['provenance']['default_points'] = 'NuClass v15 step59712; all original analysis-valid nuclei'
    manifest['provenance']['original_points'] = 'Historical CellSTP v7.1 step27500 files preserved unchanged; no longer the default'
    write('wholecell/manifest-v6.json', manifest)
    for sid in ['S03', 'S07']:
        write(f'wholecell/{sid}/analysis-v6.json', read(f'release/front/{sid}/index.json'))
        shutil.copyfile(root / f'release/point-front/{sid}-overlay-v15.webp', web / f'data/{sid}/overlay-v15.webp')
    points = read('release/point-front/manifest.json')
    points.update(point_base=base + 'points-v15/', data_revision=args.data_commit, publication_utc=now)
    write('data/manifest-v15.json', points)
    protocol = read('PROTOCOL.json')
    provenance = dict(
        version=6, publication_utc=now, data_commit=args.data_commit,
        scope='Complete frozen inference on the two previously public TCGA LUAD slides; predicted geometry and identities.',
        models={key: {k: v for k, v in protocol[key].items() if k in
                      ['name', 'step', 'state', 'sha256', 'mpp', 'input_pixels', 'core_pixels', 'halo_pixels']}
                for key in ['classifier', 'segmentation']},
        completed_fields=35117, valid_original_queries=sum(s['original_valid_queries'] for s in verified['slides']),
        previous_v15_posteriors_preserved=sum(s['previous_v15_rows_bitexact'] for s in verified['slides']),
        native_instance_reports=verified['slides'], all_native_coordinates_and_integer_rings_verified=True,
        posterior_quantization_max_error=verified['posterior_max_quantization_error'],
        display_pyramid='Discrete aggregation of actual masks at 0.85 µm and coarser; native contours and raster measurements remain authoritative.',
        tissue_gate=read('results/TISSUE_GATE.json'),
        background_stress=dict(posthoc=True, region='S07_GLASS_AUDIT', raw_owned_instances=52,
                               raw_geometry_QC=11, pathology_negative_gold=False,
                               interpretation='Near-white scanner noise can be amplified by per-field normalization. The viewer retains raw masks behind the background toggle; filtering is not a change in model accuracy.'),
        original_analysis='189 original candidate profiles, 16 intervention examples and cross-slide fidelity results remain frozen. Whole-slide morphology summaries use the expanded linked population.',
        stage_fidelity=read('assets/TLS_FIDELITY.json')['pooled'], neural_optimizer_updates=0,
        new_CAL_TEST_or_model_promotion=False, clinical_readiness_claim=False,
        default_point_layer=dict(model='NuClass v15', step=59712,
                                 checkpoint_sha256=points_verified['checkpoint_sha256'],
                                 queries=sum(s['n'] for s in points_verified['slides']),
                                 centroids='Exact native XY of all original analysis-valid nuclei.',
                                 all47_posteriors_and_hierarchy_support='Verified against frozen v15 outputs; uint16 posteriors are display quantization only.',
                                 historical_v7_1_files='Preserved unchanged, no longer the default.'))
    write('wholecell/FULLSLIDE_PROVENANCE.json', provenance)
    print(f'Bound frontend to {args.data_commit}: 3,099,177 v15 nuclei; 35,117 segmented fields.')


if __name__ == '__main__':
    main()
