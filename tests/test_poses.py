"""Unit tests for pose parsing."""

from playground.pipeline.poses import (
    approximate_fov,
    cahvor_parse,
    camera_orientation,
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


def test_cahvor_parse_cahvore_seven_vecs():
    # Typical M2020 feed: 7 length-3 vectors then scalars
    parts = ";".join(
        [
            "(0.6,0.7,-1.9)",
            "(0,0.9,0.4)",
            "(1400,500,200)",
            "(0,-200,1400)",
            "(0,0.9,0.4)",
            "(0,0.05,0)",
            "(0,0,0)",
            "2.0",
            "0.0",
        ]
    )
    m = cahvor_parse(parts, "CAHVORE")
    assert m["ok"]
    assert "C" in m and "A" in m and "H" in m and "V" in m and "E" in m


def test_camera_orientation_from_cahvor():
    import numpy as np

    # Synthetic: look +X body, H along +Y (right), V along +Z (down) → image-down = +Z, up = -Z
    C = "(0,0,0)"
    A = "(1,0,0)"
    H = "(0,1000,0)"  # pure right, |H|=1000
    V = "(0,0,1000)"  # pure down
    components = ";".join([C, A, H, V])
    ori = camera_orientation(
        instrument="NAVCAM_LEFT",
        camera_vector="(1,0,0)",
        model_type="CAHV",
        model_component_list=components,
        dimension="(1000,1000)",
        attitude="(1,0,0,0)",
    )
    look = ori["look"]
    up = ori["up"]
    right = ori["right"]
    assert look is not None and abs(look[0] - 1) < 1e-6
    assert right is not None and abs(right[1] - 1) < 1e-5  # +Y right
    assert up is not None and up[2] < 0  # up is −Z body
    assert ori["basis_source"] == "cahvor_hv"
    assert 40 < ori["hfov_deg"] < 60
    assert ori["quat_w"] == 1.0 or abs(ori["quat_w"] - 1.0) < 1e-9
