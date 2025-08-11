from __future__ import annotations

import time
from typing import Any, Dict, Optional

from playwright.sync_api import Frame, Page


DEFAULT_TIMEOUT_MS = 10000


def _now_ms() -> int:
    return int(time.time() * 1000)


def wait_url_changed(
    page: Page,
    expected: Optional[str],
    timeout_ms: int = DEFAULT_TIMEOUT_MS,
    baseline_url: Optional[str] = None,
) -> None:
    start = _now_ms()
    target = None if expected is None else str(expected)
    initial_url = page.url if baseline_url is None else baseline_url
    while _now_ms() - start < timeout_ms:
        if target is None:
            if page.url != initial_url:
                return
        else:
            if target in page.url:
                return
        time.sleep(0.05)
    raise TimeoutError(
        f"urlChanged not satisfied. expected contains={target!r}, baseline={initial_url!r}, current={page.url!r}"
    )


def wait_dom_added(context: Page | Frame, selector: Dict[str, Any], timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
    # Use built-in wait_for with state='attached'
    deadline = _now_ms() + timeout_ms
    while _now_ms() < deadline:
        try:
            # Lazy import to avoid cycle
            from .selectors import resolve_locator

            loc = resolve_locator(context, selector)
            # Ensure at least one element attached
            handle = loc.element_handle(timeout=100)
            if handle:
                return
        except Exception:
            pass
        time.sleep(0.05)
    raise TimeoutError(f"domAdded not satisfied for selector={selector}")


def wait_text_changed(context: Page | Frame, selector: Dict[str, Any], initial_text: Optional[str] = None, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
    deadline = _now_ms() + timeout_ms
    last_value = initial_text
    while _now_ms() < deadline:
        try:
            from .selectors import resolve_locator

            loc_text = resolve_locator(context, selector).inner_text(timeout=200)
            if last_value is None:
                # Any non-empty value counts as changed from unknown
                if loc_text is not None and loc_text.strip() != "":
                    return
            else:
                if loc_text != last_value:
                    return
            last_value = loc_text
        except Exception:
            # Selector may not be present yet
            pass
        time.sleep(0.05)
    raise TimeoutError("textChanged not satisfied")


def wait_layout_stable(context: Page | Frame, duration_ms: int = 500, timeout_ms: int = DEFAULT_TIMEOUT_MS) -> None:
    """Wait until layout is stable for duration_ms.

    Uses bounding rect hash of body to check stability.
    """
    start = _now_ms()
    last_rect: Optional[str] = None
    stable_since: Optional[int] = None
    while _now_ms() - start < timeout_ms:
        rect = context.evaluate(
            """
() => {
  const el = document.scrollingElement || document.documentElement || document.body;
  const r = el.getBoundingClientRect();
  return `${r.x},${r.y},${r.width},${r.height}`;
}
            """
        )
        if rect == last_rect:
            if stable_since is None:
                stable_since = _now_ms()
            if _now_ms() - stable_since >= duration_ms:
                return
        else:
            last_rect = rect
            stable_since = None
        time.sleep(0.05)
    raise TimeoutError("layoutStable not satisfied")


