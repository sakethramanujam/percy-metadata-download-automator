"""Coverage heatmap unit tests (index optional)."""

import math

import numpy as np
import pytest

from playground.api.pano import look_az_el


def test_look_az_el_forward():
    az, el = look_az_el(np.array([1.0, 0.0, 0.0]))
    assert abs(az) < 1e-9
    assert abs(el) < 1e-9


def test_look_az_el_right_and_up():
    az, el = look_az_el(np.array([0.0, 1.0, 0.0]))
    assert abs(az - math.pi / 2) < 1e-9
    assert abs(el) < 1e-9
    # look toward −Z (sky / body up)
    az2, el2 = look_az_el(np.array([0.0, 0.0, -1.0]))
    assert abs(el2 - math.pi / 2) < 1e-6


def test_stop_coverage_smoke():
    """If index exists, coverage returns a non-empty stats payload."""
    from playground.api.data import IndexNotBuiltError, load_stops

    try:
        stops = load_stops()
    except IndexNotBuiltError:
        pytest.skip("index not built")
    if stops.empty:
        pytest.skip("no stops")
    # Prefer a stop with poses
    row = stops.sort_values("n_posed", ascending=False).iloc[0]
    site = int(row["site"])
    drive = int(row["drive"])
    from playground.api.coverage import stop_coverage

    out = stop_coverage(site, drive, az_bins=36, el_bins=18)
    assert out["site"] == site
    assert out["drive"] == drive
    assert out["stats"]["n_posed"] >= 0
    assert len(out["look_counts"]) == 18
    assert len(out["look_counts"][0]) == 36
    if out["stats"]["n_posed"] > 0:
        assert out["preview_data_url"] is None or out["preview_data_url"].startswith(
            "data:image/png"
        )
