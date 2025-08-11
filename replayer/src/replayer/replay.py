from __future__ import annotations

import argparse
import json
import sys
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Dict, List, Optional, Union

from playwright.sync_api import Browser, BrowserContext, Page, Playwright, sync_playwright

from .selectors import resolve_frame, resolve_locator
from .waiters import (
    DEFAULT_TIMEOUT_MS,
    wait_dom_added,
    wait_layout_stable,
    wait_text_changed,
    wait_url_changed,
)


Action = Dict[str, Any]


@dataclass
class ReplayOptions:
    headed: bool = False
    slow_mo_ms: int = 0
    timeout_ms: int = DEFAULT_TIMEOUT_MS
    debug: bool = False


def _read_json(path: Union[str, Path]) -> Dict[str, Any]:
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _ensure_navigation(page: Page, action: Action) -> None:
    url = action.get("url")
    if not url:
        raise ValueError("navigate action requires 'url'")
    page.goto(url, wait_until="domcontentloaded")


def _perform_click(page: Page, action: Action) -> None:
    frame_chain = action.get("frameChain")
    selector = action.get("selector")
    context = resolve_frame(page, frame_chain)
    if selector is None:
        raise ValueError("click requires selector")
    resolve_locator(context, selector).click()


def _perform_type(page: Page, action: Action) -> None:
    frame_chain = action.get("frameChain")
    selector = action.get("selector")
    text = action.get("text")
    if text is None:
        raise ValueError("type requires 'text'")
    context = resolve_frame(page, frame_chain)
    resolve_locator(context, selector).fill("")
    resolve_locator(context, selector).type(str(text))


def _perform_scroll(page: Page, action: Action) -> None:
    x = int(action.get("x", 0))
    y = int(action.get("y", 0))
    page.mouse.wheel(x, y)


def _perform_set_content(page: Page, action: Action) -> None:
    html = action.get("html")
    if not isinstance(html, str):
        raise ValueError("setContent requires 'html' string")
    page.set_content(html)


def _run_waiters(page: Page, action: Action, default_timeout_ms: int, baseline_url: Optional[str]) -> None:
    waiters = action.get("waiters", []) or []
    frame_chain = action.get("frameChain")
    context = resolve_frame(page, frame_chain)
    for w in waiters:
        kind = w.get("kind")
        timeout_ms = int(w.get("timeoutMs", default_timeout_ms))
        if kind == "urlChanged":
            wait_url_changed(page, w.get("contains"), timeout_ms, baseline_url=baseline_url)
        elif kind == "domAdded":
            selector = w.get("selector")
            if selector is None:
                continue
            wait_dom_added(context, selector, timeout_ms)
        elif kind == "textChanged":
            selector = w.get("selector")
            wait_text_changed(context, selector, w.get("initialText"), timeout_ms)
        elif kind == "layoutStable":
            wait_layout_stable(context, duration_ms=int(w.get("durationMs", 500)), timeout_ms=timeout_ms)
        else:
            # Unknown waiters are ignored for now
            pass


def replay_trace(trace: Dict[str, Any], options: ReplayOptions) -> None:
    with sync_playwright() as p:
        browser = _launch_browser(p, options)
        context = browser.new_context()
        page = context.new_page()

        # Optional initial navigation
        start_url: Optional[str] = None
        meta = trace.get("meta") or {}
        if isinstance(meta, dict):
            start_url = meta.get("startUrl")
        if not start_url and hasattr(options, "start_url"):
            # type: ignore[attr-defined]
            start_url = getattr(options, "start_url")
        if start_url:
            page.goto(start_url, wait_until="domcontentloaded")

        steps: List[Action] = trace.get("steps", [])
        for idx, step in enumerate(steps):
            action = step.get("action")
            kind: Optional[str] = None

            # Support two schemas:
            # 1) Internal: step.action.kind / step.action.selector
            # 2) Recorder: step.kind in {"action","waitForPredicate"}
            if action and isinstance(action, dict) and "kind" in action:
                kind = action.get("kind")
            elif isinstance(step, dict) and step.get("kind") == "action":
                action = _normalize_action_from_recorder_step(step)
                kind = action.get("kind")
            elif isinstance(step, dict) and step.get("kind") == "waitForPredicate":
                _run_top_level_waiter_from_recorder(page, step, options)
                continue
            else:
                # Unknown step shape, skip
                continue

            # Capture baseline before performing the action
            baseline_url: Optional[str] = page.url

            if options.debug:
                print(f"[replay] step {idx}: kind={kind} action={action}")

            if kind == "navigate":
                _ensure_navigation(page, action)
            elif kind == "click":
                _perform_click(page, action)
            elif kind == "type":
                _perform_type(page, action)
            elif kind == "scroll":
                _perform_scroll(page, action)
            elif kind == "setContent":
                _perform_set_content(page, action)
            else:
                # Unsupported actions are skipped for base implementation
                if options.debug:
                    print(f"[replay] skipping unsupported action kind={kind}")

            try:
                _run_waiters(page, action, options.timeout_ms, baseline_url)
            except Exception as exc:
                if options.debug:
                    print(f"[replay] waiter error: {exc}")
                raise

        context.close()
        browser.close()


def _launch_browser(p: Playwright, options: ReplayOptions) -> Browser:
    return p.chromium.launch(headless=not options.headed, slow_mo=options.slow_mo_ms)


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Replay a recorded trace with Playwright")
    parser.add_argument("trace", type=str, help="Path to JSON trace file")
    parser.add_argument("--headed", action="store_true", help="Run with a headed browser")
    parser.add_argument("--slow-mo", type=int, default=0, help="Slow motion in ms between operations")
    parser.add_argument("--timeout-ms", type=int, default=DEFAULT_TIMEOUT_MS, help="Default waiter timeout")
    parser.add_argument("--debug", action="store_true", help="Print debug logs during replay")
    parser.add_argument("--start-url", type=str, default=None, help="Navigate to this URL before steps")
    args = parser.parse_args(argv)

    trace = _read_json(args.trace)
    opts = ReplayOptions(
        headed=bool(args.headed),
        slow_mo_ms=int(args.slow_mo),
        timeout_ms=int(args.timeout_ms),
        debug=bool(args.debug),
    )
    # Attach start_url dynamically to options without changing dataclass signature
    setattr(opts, "start_url", args.start_url)
    replay_trace(trace, opts)
    return 0


def _normalize_action_from_recorder_step(step: Dict[str, Any]) -> Action:
    """Map recorder-style step to internal action dict."""
    act = step.get("action") or {}
    name = act.get("name")
    if not isinstance(name, str):
        return {"kind": "unknown"}
    kind = name

    # Map scroll params
    if kind == "scroll":
        x = act.get("deltaX", 0)
        y = act.get("deltaY", 0)
    else:
        x = y = None

    selector = _normalize_selector_from_recorder(step.get("selector")) if step.get("selector") else None
    frame_chain = None
    if isinstance(step.get("selector"), dict):
        frame_chain = step["selector"].get("frameChain")

    result: Action = {"kind": kind}
    if selector is not None:
        result["selector"] = selector
    if frame_chain is not None:
        result["frameChain"] = frame_chain
    if x is not None and y is not None:
        result["x"] = x
        result["y"] = y
    return result


def _normalize_selector_from_recorder(selector_obj: Any) -> Any:
    if not isinstance(selector_obj, dict):
        return selector_obj
    # Recorder provides { selector: string, strategy: "css" | "aria" | ... }
    raw = selector_obj.get("selector")
    strategy = selector_obj.get("strategy")
    if not isinstance(raw, str):
        return selector_obj
    if strategy == "css" or strategy is None:
        return {"css": raw}
    if strategy == "xpath":
        return {"xpath": raw}
    if strategy == "aria":
        # Expect strings like: "role=link name=Pytest plugin"
        role_match = re.search(r"role=([^\s]+)", raw)
        name_match = re.search(r"name=(.+)", raw)
        aria: Dict[str, Any] = {}
        if role_match:
            aria["role"] = role_match.group(1)
        if name_match:
            name = name_match.group(1).strip()
            # Strip optional quotes
            if (name.startswith('"') and name.endswith('"')) or (name.startswith("'") and name.endswith("'")):
                name = name[1:-1]
            aria["name"] = name
        return {"aria": aria}
    if strategy == "text":
        # Treat as contains by default
        return {"text": {"contains": raw}}
    # Fallback to raw string as CSS
    return {"css": raw}


def _run_top_level_waiter_from_recorder(page: Page, step: Dict[str, Any], options: ReplayOptions) -> None:
    pred = step.get("predicate")
    if pred == "layoutStable":
        container = step.get("container")
        sel = _normalize_selector_from_recorder(container) if container else None
        context = page
        if sel is not None:
            # try resolving frame chain if present in container
            frame_chain = container.get("frameChain") if isinstance(container, dict) else None
            context = resolve_frame(page, frame_chain)
        wait_layout_stable(context, duration_ms=200, timeout_ms=options.timeout_ms)
    elif pred == "urlChanged":
        wait_url_changed(page, expected=None, timeout_ms=options.timeout_ms)
    elif pred == "domAdded":
        container = step.get("container")
        sel = _normalize_selector_from_recorder(container) if container else None
        if sel is not None:
            context = resolve_frame(page, container.get("frameChain") if isinstance(container, dict) else None)
            wait_dom_added(context, sel, timeout_ms=options.timeout_ms)
    elif pred == "textChanged":
        container = step.get("container")
        sel = _normalize_selector_from_recorder(container) if container else None
        if sel is not None:
            context = resolve_frame(page, container.get("frameChain") if isinstance(container, dict) else None)
            wait_text_changed(context, sel, timeout_ms=options.timeout_ms)


if __name__ == "__main__":
    sys.exit(main())


