"""Stereo pair heuristics for Navcam / Mastcam-Z / Hazcam L-R."""

from __future__ import annotations

import math
from typing import Any, Optional

import numpy as np
import pandas as pd

# Canonical left instrument for each stereo family
_STEREO_LEFT = {
    "NAVCAM_LEFT": "NAVCAM_RIGHT",
    "MCZ_LEFT": "MCZ_RIGHT",
    "FRONT_HAZCAM_LEFT_A": "FRONT_HAZCAM_RIGHT_A",
    "REAR_HAZCAM_LEFT": "REAR_HAZCAM_RIGHT",
}


def _num(v: Any) -> Optional[float]:
    if v is None or (isinstance(v, float) and math.isnan(v)):
        try:
            if pd.isna(v):
                return None
        except Exception:
            pass
        return None
    try:
        x = float(v)
        if math.isnan(x):
            return None
        return x
    except (TypeError, ValueError):
        return None


def _pos(row: pd.Series) -> Optional[np.ndarray]:
    x, y, z = _num(row.get("pos_x")), _num(row.get("pos_y")), _num(row.get("pos_z"))
    if x is None or y is None or z is None:
        return None
    return np.array([x, y, z], dtype=float)


def _look(row: pd.Series) -> Optional[np.ndarray]:
    x, y, z = _num(row.get("look_x")), _num(row.get("look_y")), _num(row.get("look_z"))
    if x is None or y is None or z is None:
        return None
    v = np.array([x, y, z], dtype=float)
    n = np.linalg.norm(v)
    if n < 1e-12:
        return None
    return v / n


def _filter_compatible(left_f: str, right_f: str) -> bool:
    """Prefer matching filters; allow UNK/empty."""
    a = (left_f or "").strip().upper()
    b = (right_f or "").strip().upper()
    if not a or not b or a == "UNK" or b == "UNK":
        return True
    # Mastcam RGB pairs L0/R0 etc.
    if a == b:
        return True
    # ZCAM_L0_RGB vs ZCAM_R0_RGB
    def norm(f: str) -> str:
        f = f.replace("ZCAM_L", "ZCAM_").replace("ZCAM_R", "ZCAM_")
        return f

    return norm(a) == norm(b)


def score_pair(left: pd.Series, right: pd.Series) -> tuple[float, dict[str, Any]]:
    """Higher is better. Returns (score, diagnostics)."""
    diag: dict[str, Any] = {}
    score = 0.0

    # Time proximity (sclk preferred)
    sl = _num(left.get("extended_sclk"))
    sr = _num(right.get("extended_sclk"))
    if sl is not None and sr is not None:
        dt = abs(sl - sr)
        diag["dt_sclk"] = dt
        # full score if < 2s, decay to 0 by 120s
        score += max(0.0, 40.0 * (1.0 - min(dt, 120.0) / 120.0))
    else:
        # same sol bonus only
        if left.get("sol") == right.get("sol") and left.get("sol") is not None:
            score += 10.0
            diag["dt_sclk"] = None

    # Baseline length (meters in local frame — typically ~0.2–0.3 m for navcam)
    pl, pr = _pos(left), _pos(right)
    if pl is not None and pr is not None:
        baseline = float(np.linalg.norm(pl - pr))
        diag["baseline_m"] = baseline
        # sweet spot ~0.05–0.5 m for rover stereo; soft peak at 0.25
        if 0.02 <= baseline <= 1.5:
            score += 25.0 * math.exp(-((baseline - 0.27) ** 2) / (2 * 0.15**2))
        elif baseline < 0.02:
            score += 5.0  # almost coincident — weak stereo
        else:
            score += 2.0  # long baseline still ok for distant scenes
    else:
        diag["baseline_m"] = None

    # Look direction agreement
    ll, lr = _look(left), _look(right)
    if ll is not None and lr is not None:
        cos = float(np.clip(np.dot(ll, lr), -1.0, 1.0))
        ang = math.degrees(math.acos(cos))
        diag["look_angle_deg"] = ang
        # prefer nearly parallel boresights
        score += max(0.0, 20.0 * (1.0 - min(ang, 30.0) / 30.0))
    else:
        diag["look_angle_deg"] = None

    # Mast angles if present
    laz, lel = _num(left.get("mast_az")), _num(left.get("mast_el"))
    raz, rel = _num(right.get("mast_az")), _num(right.get("mast_el"))
    if None not in (laz, lel, raz, rel):
        daz = abs(laz - raz)
        if daz > 180:
            daz = 360 - daz
        del_ = abs(lel - rel)
        diag["mast_delta_az"] = daz
        diag["mast_delta_el"] = del_
        score += max(0.0, 10.0 * (1.0 - min(daz, 15.0) / 15.0))
        score += max(0.0, 5.0 * (1.0 - min(del_, 10.0) / 10.0))

    # Filter match
    if _filter_compatible(str(left.get("filter_name") or ""), str(right.get("filter_name") or "")):
        score += 8.0
        diag["filter_ok"] = True
    else:
        diag["filter_ok"] = False
        score -= 5.0

    # Both posed / model ok
    if bool(left.get("has_pose")) and bool(right.get("has_pose")):
        score += 5.0
    if bool(left.get("model_ok")) and bool(right.get("model_ok")):
        score += 3.0

    return score, diag


def find_stereo_pairs(
    df: pd.DataFrame,
    *,
    max_dt_sclk: float = 60.0,
    max_pairs: int = 200,
    min_score: float = 25.0,
    families: Optional[list[str]] = None,
) -> list[dict[str, Any]]:
    """Greedy one-to-one matching of L→R within each sol and stereo family.

    families: optional subset like ["NAVCAM", "MCZ", "HAZCAM"]
    """
    if df.empty:
        return []

    work = df.copy()
    work["instrument"] = work["instrument"].astype(str).str.upper()
    # only left eyes that have a partner defined
    left_rows = work[work["instrument"].isin(_STEREO_LEFT.keys())]
    if left_rows.empty:
        return []

    pairs: list[dict[str, Any]] = []
    used_right: set[str] = set()

    # Group by sol for efficiency
    for sol, sol_df in work.groupby(work["sol"].fillna(-1)):
        rights_by_inst: dict[str, pd.DataFrame] = {
            inst: g for inst, g in sol_df.groupby("instrument")
        }
        lefts = sol_df[sol_df["instrument"].isin(_STEREO_LEFT.keys())]
        candidates: list[tuple[float, dict[str, Any]]] = []

        for _, left in lefts.iterrows():
            left_inst = str(left["instrument"])
            # family filter
            if families:
                fam_ok = any(f.upper() in left_inst for f in families)
                if not fam_ok:
                    continue
            right_inst = _STEREO_LEFT[left_inst]
            rpool = rights_by_inst.get(right_inst)
            if rpool is None or rpool.empty:
                continue

            sl = _num(left.get("extended_sclk"))
            best_local: Optional[tuple[float, pd.Series, dict]] = None
            for _, right in rpool.iterrows():
                rid = str(right["imageid"])
                if rid in used_right:
                    continue
                sr = _num(right.get("extended_sclk"))
                if sl is not None and sr is not None and abs(sl - sr) > max_dt_sclk:
                    continue
                if not _filter_compatible(
                    str(left.get("filter_name") or ""),
                    str(right.get("filter_name") or ""),
                ):
                    # still allow but score will penalize; skip harsh mismatch for ZCAM band
                    lf = str(left.get("filter_name") or "").upper()
                    rf = str(right.get("filter_name") or "").upper()
                    if "NM" in lf and "NM" in rf and lf != rf:
                        continue

                sc, diag = score_pair(left, right)
                if sc < min_score:
                    continue
                if best_local is None or sc > best_local[0]:
                    best_local = (sc, right, diag)

            if best_local is None:
                continue
            sc, right, diag = best_local
            pl, pr = _pos(left), _pos(right)
            pair = {
                "id": f"{left['imageid']}__{right['imageid']}",
                "sol": _safe_sol(sol),
                "family": left_inst.replace("_LEFT", "").replace("_LEFT_A", ""),
                "left_imageid": str(left["imageid"]),
                "right_imageid": str(right["imageid"]),
                "left_instrument": left_inst,
                "right_instrument": str(right["instrument"]),
                "left_filter": str(left.get("filter_name") or ""),
                "right_filter": str(right.get("filter_name") or ""),
                "score": round(sc, 2),
                "baseline_m": diag.get("baseline_m"),
                "dt_sclk": diag.get("dt_sclk"),
                "look_angle_deg": diag.get("look_angle_deg"),
                "left_pos": _xyz_list(pl),
                "right_pos": _xyz_list(pr),
                "left_look": _xyz_list(_look(left)),
                "right_look": _xyz_list(_look(right)),
            }
            candidates.append((sc, pair))

        # Greedy assign highest score first (one right per pair)
        candidates.sort(key=lambda x: -x[0])
        for sc, pair in candidates:
            if pair["right_imageid"] in used_right:
                continue
            used_right.add(pair["right_imageid"])
            pairs.append(pair)

    pairs.sort(key=lambda p: (-p["score"], p.get("sol") or 0))
    return pairs[:max_pairs]


def _xyz_list(v: Optional[np.ndarray]) -> Optional[list[float]]:
    if v is None:
        return None
    return [float(v[0]), float(v[1]), float(v[2])]


def _safe_sol(sol: Any) -> Optional[int]:
    try:
        if sol is None or (isinstance(sol, float) and math.isnan(sol)):
            return None
        s = int(sol)
        return None if s < 0 else s
    except Exception:
        return None
