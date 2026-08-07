"""Unit tests for pose parsing."""

from playground.pipeline.poses import (
    approximate_fov,
    cahvor_parse,
    has_pose,
    normalize_vector,
    parse_tuple,
    quat_to_matrix,
    stereo_partner_instrument,
)


def test_parse_tuple():
    v = parse_tuple("(0.915645,0.00852871,0.00545543,-0.40186)")
    assert v is not None and v.size == 4
    assert abs(v[0] - 0.915645) < 1e-6


def test_quat_matrix_identityish():
    import numpy as np

    R = quat_to_matrix(np.array([1.0, 0.0, 0.0, 0.0]))
    assert abs(R[0, 0] - 1) < 1e-9


def test_cahvor_six():
    # six dummy vectors
    parts = ";".join(["(1,0,0)", "(0,1,0)", "(0,0,1)", "(1,1,0)", "(0,1,1)", "(1,0,1)"])
    m = cahvor_parse(parts, "CAHVOR")
    assert m["ok"]
    assert "C" in m and "R" in m


def test_stereo_partner():
    assert stereo_partner_instrument("NAVCAM_LEFT") == "NAVCAM_RIGHT"
    assert stereo_partner_instrument("MCZ_RIGHT") == "MCZ_LEFT"


def test_has_pose():
    import numpy as np

    assert has_pose(np.array([1.0, 2.0, 3.0]), normalize_vector(np.array([0, 1, 0])))
    assert not has_pose(None, np.array([0, 1, 0]))


def test_fov():
    h, v = approximate_fov("NAVCAM_LEFT")
    assert h > 0 and v > 0
