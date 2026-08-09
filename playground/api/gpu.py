"""GPU capability detection for the playground."""

from __future__ import annotations

from functools import lru_cache
from typing import Any


@lru_cache(maxsize=1)
def gpu_info() -> dict[str, Any]:
    """Return a JSON-serializable summary of compute devices."""
    info: dict[str, Any] = {
        "cuda_available": False,
        "device": "cpu",
        "torch": None,
        "opencv_cuda_devices": 0,
        "name": None,
        "vram_mb": None,
        "capability": None,
    }
    try:
        import cv2

        if hasattr(cv2, "cuda"):
            info["opencv_cuda_devices"] = int(cv2.cuda.getCudaEnabledDeviceCount())
    except Exception:
        pass

    try:
        import torch

        info["torch"] = torch.__version__
        if torch.cuda.is_available():
            info["cuda_available"] = True
            info["device"] = "cuda:0"
            info["name"] = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            info["vram_mb"] = int(props.total_memory / (1024 * 1024))
            info["capability"] = f"{props.major}.{props.minor}"
            info["cuda_version"] = getattr(torch.version, "cuda", None)
    except Exception as e:
        info["torch_error"] = str(e)

    return info


def torch_device():
    """Return a torch.device preferring CUDA."""
    import torch

    if torch.cuda.is_available():
        return torch.device("cuda:0")
    return torch.device("cpu")
