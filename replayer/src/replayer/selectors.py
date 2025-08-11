from __future__ import annotations

from typing import Any, Dict, List, Optional, Union

from playwright.sync_api import Frame, Locator, Page


SelectorSpec = Union[str, Dict[str, Any]]
FrameSelector = Dict[str, Any]


def _normalize_selector(selector: SelectorSpec) -> Dict[str, Any]:
    """Normalize selector into a dict form we understand.

    Supported forms:
    - string: treated as CSS selector
    - {"css": "..."}
    - {"xpath": "..."}
    - {"aria": {"role": "button", "name": "Submit"}}
    - {"text": "Exact text"}
    """

    if isinstance(selector, str):
        return {"css": selector}

    if not isinstance(selector, dict):
        raise ValueError(f"Unsupported selector type: {type(selector)}")

    # Validate supported keys
    supported = {"css", "xpath", "aria", "text"}
    if not any(k in selector for k in supported):
        raise ValueError(f"Selector must include one of {supported}: {selector}")

    return selector


def resolve_locator(search_context: Union[Page, Frame], selector: SelectorSpec) -> Locator:
    """Create a Playwright Locator from a selector spec within the given context."""

    norm = _normalize_selector(selector)

    if "css" in norm:
        return search_context.locator(norm["css"])  # CSS by default

    if "xpath" in norm:
        return search_context.locator(f"xpath={norm['xpath']}")

    if "text" in norm:
        # Exact text by default; for partial, pass {"text": {"contains": "..."}}
        value = norm["text"]
        if isinstance(value, dict) and "contains" in value:
            return search_context.get_by_text(value["contains"], exact=False)
        return search_context.get_by_text(str(value), exact=True)

    if "aria" in norm:
        aria = norm["aria"] or {}
        role = aria.get("role")
        name = aria.get("name")
        if role:
            if name is not None:
                return search_context.get_by_role(role, name=str(name), exact=True)
            return search_context.get_by_role(role)
        # fallback to accessible name
        if name is not None:
            # If only name is provided, match by text content accessibility tree
            return search_context.get_by_text(str(name), exact=True)
        raise ValueError(f"ARIA selector requires at least role or name: {norm}")

    # Should not reach here
    raise ValueError(f"Unsupported selector: {selector}")


def resolve_frame(page: Page, frame_chain: Optional[List[FrameSelector]]) -> Union[Page, Frame]:
    """Resolve a frame given a frame chain description.

    Frame selector supports one of:
    - {"urlContains": "partial"}
    - {"name": "frameName"}
    - {"index": 0}
    The chain is resolved sequentially; when empty or None returns the page.
    """

    if not frame_chain:
        return page

    current: Union[Page, Frame] = page
    for level in frame_chain:
        if not isinstance(level, dict):
            raise ValueError(f"Frame selector must be a dict, got: {level}")

        target: Optional[Frame] = None
        frames = list(current.child_frames) if isinstance(current, Frame) else list(page.frames)

        if "index" in level:
            idx = int(level["index"])  # type: ignore[arg-type]
            # When current is Page, frames includes main frame at index 0 in Playwright.
            if 0 <= idx < len(frames):
                target = frames[idx]
        elif "name" in level:
            name = str(level["name"])
            for f in frames:
                if f.name == name:
                    target = f
                    break
        elif "urlContains" in level:
            part = str(level["urlContains"]).lower()
            for f in frames:
                if part in f.url.lower():
                    target = f
                    break
        else:
            raise ValueError(f"Unsupported frame selector: {level}")

        if target is None:
            raise RuntimeError(f"Frame not found for selector {level}")

        current = target

    return current


