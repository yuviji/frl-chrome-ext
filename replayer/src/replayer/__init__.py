from __future__ import annotations

# Intentionally avoid importing submodules at package import time to prevent
# runpy warnings when executing `python -m replayer.replay`.

__all__ = ["replay_trace", "ReplayOptions"]


def __getattr__(name: str):  # pragma: no cover - thin wrapper
    if name in __all__:
        from .replay import ReplayOptions, replay_trace

        return {"replay_trace": replay_trace, "ReplayOptions": ReplayOptions}[name]
    raise AttributeError(name)
