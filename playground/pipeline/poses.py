"""Parse NASA Mars 2020 metadata pose / camera model strings."""

from __future__ import annotations

import math
import re
from typing import Any, Optional

import numpy as np

_NUM = re.compile(r"[-+]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][-+]?\d+)?")

# Rough horizontal FOV (degrees) fallbacks when CAHVOR is missing.
_INSTRUMENT_HFOV_DEG: dict[str, float] = {
    "NAVCAM_LEFT": 45.0,
    "NAVCAM_RIGHT": 45.0,
    "MCZ_LEFT": 18.0,
    "MCZ_RIGHT": 18.0,
    "FRONT_HAZCAM_LEFT_A": 90.0,
    "FRONT_HAZCAM_RIGHT_A": 90.0,
    "REAR_HAZCAM_LEFT": 90.0,
    "REAR_HAZCAM_RIGHT": 90.0,
    "SUPERCAM_RMI": 1.0,
    "SHERLOC_WATSON": 30.0,
}


def parse_tuple(value: Any) -> Optional[np.ndarray]:
    """Parse strings like '(1.0,2.0,3.0)' or '(a;b)' lists into float arrays."""
    if value is None or (isinstance(value, float) and math.isnan(value)):
        return None
    if isinstance(value, (list, tuple, np.ndarray)):
        arr = np.asarray(value, dtype=float).ravel()
        return arr if arr.size else None
    s = str(value).strip()
    if not s or s.upper() == "UNK" or s.lower() == "nan":
        return None
    nums = _NUM.findall(s)
    if not nums:
        return None
    return np.asarray([float(x) for x in nums], dtype=float)


def quat_to_matrix(q: np.ndarray) -> np.ndarray:
    """Convert quaternion (w, x, y, z) or (x, y, z, w) to 3x3 rotation.

    NASA feed attitudes appear as (w, x, y, z) with |q|≈1 and w often dominant.
    We detect layout by assuming the component with largest abs is w if ambiguous,
    defaulting to (w, x, y, z) which matches observed Perseverance metadata.
    """
    q = np.asarray(q, dtype=float).ravel()
    if q.size != 4:
        raise ValueError(f"quaternion must have 4 components, got {q.size}")
    # Default: (w, x, y, z)
    w, x, y, z = q
    n = math.sqrt(w * w + x * x + y * y + z * z)
    if n < 1e-12:
        return np.eye(3)
    w, x, y, z = w / n, x / n, y / n, z / n
    return np.array(
        [
            [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
            [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
            [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
        ],
        dtype=float,
    )


def yaw_from_quat(q: np.ndarray) -> float:
    """Extract yaw (radians) from quaternion via rotation matrix."""
    R = quat_to_matrix(q)
    # yaw about +Z of local frame
    return float(math.atan2(R[1, 0], R[0, 0]))


def cahvor_parse(
    component_list: Any, model_type: Any
) -> dict[str, Any]:
    """Parse semicolon-separated CAHV / CAHVOR / CAHVORE vector lists.

    Returns dict with keys present among C,A,H,V,O,R,E (each length-3 arrays)
    plus model_type and ok flag.
    """
    mtype = (str(model_type).strip().upper() if model_type is not None else "UNK")
    out: dict[str, Any] = {"model_type": mtype, "ok": False}
    if not component_list or mtype in ("", "UNK", "NAN"):
        return out

    text = str(component_list).strip()
    # Split on ';' between vector groups: "(x,y,z);(x,y,z);..."
    parts = [p.strip() for p in text.split(";") if p.strip()]
    vecs: list[np.ndarray] = []
    for p in parts:
        arr = parse_tuple(p)
        if arr is None or arr.size < 3:
            continue
        vecs.append(arr[:3])

    names_by_count = {
        4: list("CAHV"),
        6: list("CAHVOR"),
        9: list("CAHVORE"),
    }
    # Prefer model_type naming when counts match
    if mtype == "CAHV" and len(vecs) >= 4:
        names = list("CAHV")
    elif mtype == "CAHVOR" and len(vecs) >= 6:
        names = list("CAHVOR")
    elif mtype == "CAHVORE" and len(vecs) >= 9:
        names = list("CAHVORE")
    else:
        names = names_by_count.get(len(vecs), [f"v{i}" for i in range(len(vecs))])

    for name, vec in zip(names, vecs):
        out[name] = vec
    out["ok"] = len(vecs) >= 4
    out["n_vectors"] = len(vecs)
    return out


def approximate_fov(instrument: Any) -> tuple[float, float]:
    """Return (horizontal_fov_deg, vertical_fov_deg) fallbacks."""
    key = str(instrument or "").strip().upper()
    h = _INSTRUMENT_HFOV_DEG.get(key, 40.0)
    # assume ~4:3 sensor
    v = h * 0.75
    return h, v


def normalize_vector(v: Optional[np.ndarray]) -> Optional[np.ndarray]:
    if v is None or v.size < 3:
        return None
    v = np.asarray(v[:3], dtype=float)
    n = float(np.linalg.norm(v))
    if n < 1e-12:
        return None
    return v / n


def has_pose(pos: Optional[np.ndarray], look: Optional[np.ndarray]) -> bool:
    return pos is not None and pos.size >= 3 and look is not None and look.size >= 3


def stereo_partner_instrument(instrument: str) -> Optional[str]:
    """Map L↔R for known stereo pairs."""
    s = instrument.upper()
    pairs = {
        "NAVCAM_LEFT": "NAVCAM_RIGHT",
        "NAVCAM_RIGHT": "NAVCAM_LEFT",
        "MCZ_LEFT": "MCZ_RIGHT",
        "MCZ_RIGHT": "MCZ_LEFT",
        "FRONT_HAZCAM_LEFT_A": "FRONT_HAZCAM_RIGHT_A",
        "FRONT_HAZCAM_RIGHT_A": "FRONT_HAZCAM_LEFT_A",
        "REAR_HAZCAM_LEFT": "REAR_HAZCAM_RIGHT",
        "REAR_HAZCAM_RIGHT": "REAR_HAZCAM_LEFT",
    }
    return pairs.get(s)
