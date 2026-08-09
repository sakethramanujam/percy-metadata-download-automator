"""Stereo depth unit tests (no network)."""

import numpy as np
import pytest

from playground.api.depth import (
    approximate_depth_m,
    camera_cloud_to_body,
    compute_disparity,
    disparity_to_point_cloud,
    has_opencv,
)


@pytest.mark.skipif(not has_opencv(), reason="opencv not installed")
def test_sgbm_synthetic_shift():
    import cv2

    rng = np.random.default_rng(1)
    h, w = 180, 240
    base = (rng.random((h, w)) * 255).astype(np.uint8)
    base = cv2.GaussianBlur(base, (5, 5), 0)
    shift = 10
    left = base
    right = np.roll(base, -shift, axis=1)
    out = compute_disparity(left, right, num_disparities=64, block_size=5)
    assert out["stats"]["n_valid"] > 1000
    med = out["stats"]["disp_median"]
    assert med is not None
    # Median disparity should be near the imposed shift
    assert abs(med - shift) < 2.5
    assert out["preview_png"][:8] == b"\x89PNG\r\n\x1a\n"


def test_approximate_depth():
    z = approximate_depth_m(10.0, baseline_m=0.2, focal_px=500.0)
    assert z is not None
    assert abs(z - 10.0) < 1e-6
    assert approximate_depth_m(0, 0.2, 500) is None


def test_disparity_to_point_cloud_center():
    """Center pixel at known disparity → Z = f*B/d along optical axis."""
    h, w = 20, 30
    disp = np.zeros((h, w), dtype=np.float32)
    disp[h // 2, w // 2] = 10.0
    cloud = disparity_to_point_cloud(
        disp, baseline_m=0.2, focal_px=500.0, max_points=100, min_disp=0.5
    )
    assert cloud["n"] == 1
    x, y, z = cloud["points"][0]
    assert abs(z - 10.0) < 1e-3  # f*B/d = 500*0.2/10
    assert abs(x) < 1e-3
    assert abs(y) < 1e-3
    assert cloud["frame"] == "camera"


def test_camera_cloud_to_body_forward_look():
    """Camera Z maps along body look; origin offset preserved."""
    cam = {
        "n": 2,
        "points": [[0.0, 0.0, 2.0], [0.1, 0.0, 2.0]],
        "colors": [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0]],
        "frame": "camera",
    }
    origin = np.array([1.0, 0.0, 0.0])  # body +X forward position of cam
    look = np.array([1.0, 0.0, 0.0])  # look +X body
    up = np.array([0.0, 0.0, -1.0])  # body up = −Z
    body = camera_cloud_to_body(cam, origin=origin, look=look, up=up)
    assert body["frame"] == "body"
    assert body["n"] == 2
    # Point on optical axis at 2m: origin + 2*look
    p0 = body["points"][0]
    assert abs(p0[0] - 3.0) < 1e-4
    assert abs(p0[1]) < 1e-4
    assert abs(p0[2]) < 1e-4
    # X right in camera → +Y body (right)
    p1 = body["points"][1]
    assert abs(p1[0] - 3.0) < 1e-4
    assert abs(p1[1] - 0.1) < 1e-4
    assert body["colors"] is not None
