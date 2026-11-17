"""Build continuous TLS envelopes from the frozen 5 µm candidate masks.

Requires numpy, scipy, scikit-image and shapely. No model inference or new labels.
Run from any directory: python scripts/build_tls_boundaries.py
The original analyses and contours are read-only inputs.
"""
import hashlib
import json
from pathlib import Path

import numpy as np
from scipy import ndimage as ndi
from shapely.geometry import Polygon
from skimage.draw import polygon2mask
from skimage.measure import find_contours
from skimage.morphology import disk

WEB = Path(__file__).resolve().parents[1] / 'cell-tree/nuclass-reviewer/wholecell'
GRID = 5
CLOSE_RADIUS = 40
SMOOTH_SIGMA = 10
SIMPLIFY = 1
PAD = 24


def sha(data):
    return hashlib.sha256(data).hexdigest()


def source_mask(region, mpp):
    # Published vertices lie on the 5 µm marching-squares half-grid. Snap away
    # native-coordinate rounding, then sample at pixel centres (+0.5 grid).
    # This reconstruction was compared bit-for-bit with all 189 saved NPZ masks.
    rings = [np.round(np.asarray(r) * mpp / GRID * 2) / 2
             for r in region['refined_rings']]
    points = np.concatenate(rings)
    origin = np.floor(points.min(axis=0)).astype(int) - PAD
    shape = (np.ceil(points.max(axis=0)).astype(int) - origin + PAD)[::-1]
    mask = np.zeros(shape, dtype=bool)
    for ring in rings:
        mask ^= polygon2mask(shape, (ring - origin - .5)[:, ::-1])
    return mask, origin * GRID


def envelope(mask, origin):
    filled = ndi.binary_fill_holes(mask)
    closed = ndi.binary_closing(filled, structure=disk(CLOSE_RADIUS // GRID))
    closed = ndi.binary_fill_holes(closed)
    smooth = ndi.gaussian_filter(closed.astype(float), SMOOTH_SIGMA / GRID)
    contours = find_contours(smooth, .5)
    assert len(contours) == 1, 'Envelope must have one exterior and no inner rings'
    xy = (contours[0][:, ::-1] + .5) * GRID + origin
    poly = Polygon(xy).simplify(SIMPLIFY, preserve_topology=True)
    assert poly.is_valid and poly.exterior.is_simple and not poly.interiors
    xy = np.asarray(poly.exterior.coords)
    result = polygon2mask(mask.shape, ((xy - origin) / GRID - .5)[:, ::-1])
    assert ndi.label(result)[1] == 1
    assert np.array_equal(result, ndi.binary_fill_holes(result))
    holes = filled & ~mask
    assert np.all(result[holes]), 'A previously enclosed hole remains excluded'
    return result, poly


def write(path, data):
    payload = (json.dumps(data, separators=(',', ':'), allow_nan=False) + '\n').encode()
    path.write_bytes(payload)
    return {'file': str(path.relative_to(WEB)), 'bytes': len(payload), 'sha256': sha(payload)}


def main():
    manifest = json.loads((WEB / 'manifest-v6.json').read_text())
    audit = {
        'version': 2,
        'method': 'Filled continuous TLS envelope from saved 5 µm refinement',
        'parameters': {'grid_um': GRID, 'closing_disk_radius_um': CLOSE_RADIUS,
                       'gaussian_sigma_um': SMOOTH_SIGMA, 'simplify_tolerance_um': SIMPLIFY},
        'policy': 'Fill internal holes, close narrow clefts, smooth the outer boundary. '
                  'An enclosing region can include internal lumina; it is not a tissue-only mask. '
                  'No circle or convex hull is fitted. Candidate identities are retained.',
        'analysis_policy': 'Original counts, composition, stages and sensitivity tables remain frozen. '
                           'Envelope areas describe this boundary revision only; not reclassified cells.',
        'data_revision': manifest['data_revision'],
        'sources': {}, 'files': {}, 'slides': {}, 'regions': [],
    }
    for sid in ['S03', 'S07']:
        path = WEB / sid / 'analysis-v6.json'
        raw = path.read_bytes()
        source = json.loads(raw)
        mpp = np.asarray(source['mpp'])
        audit['sources'][sid] = {'file': f'{sid}/analysis-v6.json', 'sha256': sha(raw)}
        regions, polygons, rows = [], [], []
        for r in source['regions']:
            if r['control']:
                continue
            mask, origin = source_mask(r, mpp)
            result, poly = envelope(mask, origin)
            # Regression guard against a coordinate-scale mismatch in reconstruction.
            old_area = int(mask.sum()) * GRID**2
            assert abs(old_area / 1e6 - r['boundary_refinement']['refined_area_mm2']) < 1e-9
            rings = [np.round(np.asarray(poly.exterior.coords) / mpp, 3).tolist()]
            native = Polygon(rings[0])
            assert native.is_valid and native.exterior.is_simple
            holes = ndi.binary_fill_holes(mask) & ~mask
            row = {
                'id': r['id'], 'slide': sid,
                'previous_holes': int(ndi.label(holes)[1]),
                'filled_hole_area_um2': int(holes.sum()) * GRID**2,
                'previous_area_mm2': old_area / 1e6,
                'area_mm2': round(poly.area / 1e6, 8),
                'area_change_pct': round(100 * (poly.area / old_area - 1), 4),
                'added_area_um2': int((result & ~mask).sum()) * GRID**2,
                'removed_area_um2': int((mask & ~result).sum()) * GRID**2,
                'components': 1, 'holes': 0,
                'review_required': abs(poly.area / old_area - 1) > .10,
            }
            rows.append(row)
            regions.append({'id': r['id'], 'rings': rings,
                            'bounds': list(native.bounds), 'audit': row})
            polygons.append((r['id'], poly))
        for i, (rid, poly) in enumerate(polygons):
            for other_id, other in polygons[:i]:
                assert poly.intersection(other).area < 1e-6, f'Overlapping candidates: {rid}, {other_id}'
        data = {'version': 2, 'slide': sid, 'mpp': mpp.tolist(),
                'data_revision': manifest['data_revision'],
                'source_index_sha256': manifest['remote_indexes'][sid]['sha256'],
                'regions': regions}
        audit['files'][sid] = write(WEB / sid / 'tls-boundaries-v2.json', data)
        audit['slides'][sid] = {
            'candidates': len(rows), 'previous_candidates_with_holes': sum(r['previous_holes'] > 0 for r in rows),
            'previous_holes': sum(r['previous_holes'] for r in rows),
            'corrected_holes': 0, 'disconnected_candidates': 0,
            'self_intersections': 0, 'overlapping_candidate_pairs': 0,
            'area_change_review': [r['id'] for r in rows if r['review_required']],
        }
        audit['regions'].extend(rows)
    report = write(WEB / 'TLS_BOUNDARY_AUDIT_V2.json', audit)
    write(WEB / 'TLS_BOUNDARIES_V2.json', {
        'version': 2, 'data_revision': manifest['data_revision'],
        'files': audit['files'], 'audit': report,
    })
    print(json.dumps(audit['slides'], indent=2))


if __name__ == '__main__':
    main()
