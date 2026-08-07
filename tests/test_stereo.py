"""Tests for stereo pair matching."""

import pandas as pd

from playground.api.stereo import find_stereo_pairs, score_pair


def _cam(imageid, inst, sol, sclk, x, y, z, lx=0, ly=1, lz=0, filt="UNK"):
    return {
        "imageid": imageid,
        "instrument": inst,
        "sol": sol,
        "extended_sclk": sclk,
        "pos_x": x,
        "pos_y": y,
        "pos_z": z,
        "look_x": lx,
        "look_y": ly,
        "look_z": lz,
        "mast_az": 10.0,
        "mast_el": -5.0,
        "filter_name": filt,
        "has_pose": True,
        "model_ok": True,
    }


def test_find_navcam_pair():
    df = pd.DataFrame(
        [
            _cam("L1", "NAVCAM_LEFT", 100, 1000.0, 0.0, 0.0, 0.0),
            _cam("R1", "NAVCAM_RIGHT", 100, 1000.2, 0.27, 0.0, 0.0),
            _cam("L2", "NAVCAM_LEFT", 100, 2000.0, 1.0, 0.0, 0.0),
            _cam("R2", "NAVCAM_RIGHT", 100, 2000.1, 1.27, 0.0, 0.0),
        ]
    )
    pairs = find_stereo_pairs(df, max_pairs=10, min_score=20)
    assert len(pairs) >= 2
    ids = {(p["left_imageid"], p["right_imageid"]) for p in pairs}
    assert ("L1", "R1") in ids
    assert pairs[0]["score"] >= pairs[-1]["score"]


def test_score_prefers_close_time():
    left = pd.Series(_cam("L", "NAVCAM_LEFT", 1, 100.0, 0, 0, 0))
    near = pd.Series(_cam("R1", "NAVCAM_RIGHT", 1, 100.5, 0.25, 0, 0))
    far = pd.Series(_cam("R2", "NAVCAM_RIGHT", 1, 200.0, 0.25, 0, 0))
    s1, _ = score_pair(left, near)
    s2, _ = score_pair(left, far)
    assert s1 > s2
