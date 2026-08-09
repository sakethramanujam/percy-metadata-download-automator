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
    """Extract yaw (radians) from quaternion via rotation matrix.

    Body/site convention: +Z down (NED-like for rover). Yaw about +Z (down)
    from the body X axis projected on the horizontal plane.
    """
    R = quat_to_matrix(q)
    # Column 0 of R is body +X expressed in the parent frame (if R body→parent)
    # atan2(y, x) of forward horizontal component
    return float(math.atan2(R[1, 0], R[0, 0]))


def pitch_roll_from_quat(q: np.ndarray) -> tuple[float, float]:
    """Return (pitch, roll) radians from attitude quaternion (body→parent)."""
    R = quat_to_matrix(q)
    # Standard ZYX-ish with +Z down is awkward; extract from body axes in parent:
    # forward = R[:,0], down ≈ R[:,2]
    forward = R[:, 0]
    # pitch: elevation of forward above horizontal (x-y plane if Z is down)
    # with +Z down, horizontal magnitude is hypot(fx,fy), pitch positive = nose up = -fz?
    horiz = math.hypot(float(forward[0]), float(forward[1]))
    pitch = float(math.atan2(-forward[2], horiz))  # nose up positive if Z down
    # roll about forward: body right vs horizontal
    right = R[:, 1]
    roll = float(math.atan2(right[2], math.hypot(right[0], right[1])))
    return pitch, roll


def cahvor_parse(
    component_list: Any, model_type: Any
) -> dict[str, Any]:
    """Parse semicolon-separated CAHV / CAHVOR / CAHVORE vector lists.

    Returns dict with keys present among C,A,H,V,O,R,E (each length-3 arrays)
    plus model_type and ok flag.

    Mars 2020 feed often stores CAHVORE as 7 length-3 vectors (C,A,H,V,O,R,E)
    followed by scalar parameters — we keep the first 7 vectors.
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
        vecs.append(arr[:3].astype(float))

    # Prefer model_type naming; accept short CAHVORE (7 vecs) as seen in feed
    if mtype == "CAHV" and len(vecs) >= 4:
        names = list("CAHV")
    elif mtype == "CAHVOR" and len(vecs) >= 6:
        names = list("CAHVOR")
    elif mtype == "CAHVORE" and len(vecs) >= 7:
        names = list("CAHVORE")
    elif len(vecs) >= 7:
        names = list("CAHVORE")
    elif len(vecs) >= 6:
        names = list("CAHVOR")
    elif len(vecs) >= 4:
        names = list("CAHV")
    else:
        names = [f"v{i}" for i in range(len(vecs))]

    for name, vec in zip(names, vecs):
        out[name] = vec
    out["ok"] = len(vecs) >= 4 and "C" in out and "A" in out
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


def _orthonormal_basis(
    look: np.ndarray, up_hint: np.ndarray
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Build right-handed right, up, look unit vectors (look is -Z of OpenGL cam)."""
    look = look / (np.linalg.norm(look) + 1e-15)
    # remove look component from up_hint
    up = up_hint - look * float(np.dot(up_hint, look))
    nu = float(np.linalg.norm(up))
    if nu < 1e-9:
        # pick a horizontal fallback (body +Z is down → body "up" is -Z)
        up = np.array([0.0, 0.0, -1.0])
        up = up - look * float(np.dot(up, look))
        nu = float(np.linalg.norm(up))
        if nu < 1e-9:
            up = np.array([0.0, 1.0, 0.0])
            up = up - look * float(np.dot(up, look))
            nu = float(np.linalg.norm(up))
    up = up / (nu + 1e-15)
    right = np.cross(look, up)
    nr = float(np.linalg.norm(right))
    if nr < 1e-9:
        right = np.array([1.0, 0.0, 0.0])
    else:
        right = right / nr
    # re-orthogonalize up
    up = np.cross(right, look)
    up = up / (np.linalg.norm(up) + 1e-15)
    return right, up, look


def camera_orientation(
    *,
    instrument: Any = None,
    camera_vector: Any = None,
    model_type: Any = None,
    model_component_list: Any = None,
    dimension: Any = None,
    attitude: Any = None,
) -> dict[str, Any]:
    """Full camera orientation in the metadata frame (typically rover body).

    Preference order for look:
      1) camera_camera_vector (explicit)
      2) CAHVOR A axis

    Up / right from CAHVOR H,V when available (image axes), else body-up (−Z)
    or attitude-derived world-up transformed into body.

    FOV from CAHVOR H/V magnitudes + image dimension when possible.
    """
    look = normalize_vector(parse_tuple(camera_vector))
    m = cahvor_parse(model_component_list, model_type)
    C = m.get("C")
    A = normalize_vector(m.get("A")) if m.get("A") is not None else None
    H = m.get("H")
    V = m.get("V")

    if look is None and A is not None:
        look = A

    # Default FOV
    hfov, vfov = approximate_fov(instrument)
    dim = parse_tuple(dimension)
    img_w = float(dim[0]) if dim is not None and dim.size >= 2 else None
    img_h = float(dim[1]) if dim is not None and dim.size >= 2 else None

    right: Optional[np.ndarray] = None
    up: Optional[np.ndarray] = None
    basis_source = "fallback"

    if look is not None and H is not None and V is not None:
        H = np.asarray(H, dtype=float).ravel()[:3]
        V = np.asarray(V, dtype=float).ravel()[:3]
        # Image axes projected perpendicular to look (use look not A so H/V match vector)
        hs = H - look * float(np.dot(H, look))
        vs = V - look * float(np.dot(V, look))
        nhs = float(np.linalg.norm(hs))
        nvs = float(np.linalg.norm(vs))
        if nhs > 1e-9 and nvs > 1e-9:
            # CAHV: increasing sample along +H, line along +V (often +V is image-down)
            # For a world "up" we want opposite of image-down when V points down the image
            right = hs / nhs
            up_img = vs / nvs  # image +Y (down in many cams)
            # World up ≈ -image_down for upright display
            up = -up_img
            # Re-orthonormalize to a right-handed frame with look
            right, up, look = _orthonormal_basis(look, up)
            basis_source = "cahvor_hv"
            if img_w and img_h and nhs > 1e-6 and nvs > 1e-6:
                hfov = float(2.0 * math.degrees(math.atan((img_w * 0.5) / nhs)))
                vfov = float(2.0 * math.degrees(math.atan((img_h * 0.5) / nvs)))
                # clamp insane values
                hfov = min(max(hfov, 1.0), 170.0)
                vfov = min(max(vfov, 1.0), 170.0)

    if look is not None and (right is None or up is None):
        # Body frame: +Z down → geometric up is −Z
        up_hint = np.array([0.0, 0.0, -1.0])
        q = parse_tuple(attitude)
        if q is not None and q.size == 4:
            # Attitude is typically rover body→site; if vectors are already body
            # frame, only use attitude as a soft up refinement via site gravity.
            # Site +Z is also down-ish; body up in site is -R[:,2] if R body→site
            try:
                R = quat_to_matrix(q)
                # Parent-frame "up" = -parent Z if Z-down, map back to body: R.T @ up_parent
                up_parent = np.array([0.0, 0.0, -1.0])
                up_hint = R.T @ up_parent
                basis_source = "attitude_up"
            except Exception:
                basis_source = "body_up"
        else:
            basis_source = "body_up"
        right, up, look = _orthonormal_basis(look, up_hint)

    # Attitude quaternion components (rover body orientation)
    quat_w = quat_x = quat_y = quat_z = float("nan")
    yaw = pitch = roll = float("nan")
    q = parse_tuple(attitude)
    if q is not None and q.size == 4:
        n = float(np.linalg.norm(q))
        if n > 1e-12:
            qn = q / n
            quat_w, quat_x, quat_y, quat_z = map(float, qn)
            try:
                yaw = yaw_from_quat(qn)
                pitch, roll = pitch_roll_from_quat(qn)
            except Exception:
                pass

    out: dict[str, Any] = {
        "look": look,
        "up": up,
        "right": right,
        "C": C,
        "hfov_deg": hfov,
        "vfov_deg": vfov,
        "basis_source": basis_source,
        "model_ok": bool(m.get("ok")),
        "quat_w": quat_w,
        "quat_x": quat_x,
        "quat_y": quat_y,
        "quat_z": quat_z,
        "yaw_rad": yaw,
        "pitch_rad": pitch,
        "roll_rad": roll,
    }
    return out


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
