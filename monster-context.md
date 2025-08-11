# Monster Context – Altera-Style Recorder/Replayer

Keep this file attached to every step.

## Goal
Chrome MV3 extension records browser actions into a generic trace with wait predicates.  
Python Playwright replayer replays across multi-tab, iframe, shadow DOM.  
Modal-hosted OCR fallback when selectors fail.  
Versioned JSON schema. CI demos. Real ChatGPT trace.

## Extension
- MV3, TypeScript, Vite.
- Content script: capture actions, selectors, hints, wait predicates.
- Background: aggregate steps, tab lifecycle.
- Popup: start/stop/download, allowlist toggle.
- Selector order: ARIA > data-testid > compact CSS.
- Sensors: MutationObserver, layout stable, URL/title change, aria-live, network inflight, optional visual hash.

## Replayer
- Python 3, Playwright.
- Validate JSON schema, replay actions, wait predicates.
- OCR fallback (Modal).
- Multi-tab, frames, shadow DOM, drag/wheel.
- Debug: --debug, --screenshot-on-fail.

## Modal OCR
- FastAPI, PaddleOCR.
- Input: base64 img, query.
- Output: bbox, confidence, text.

## JSON Trace
- Meta: version, recorder, startedAt, userAgent, viewport.
- Steps: actions (click, type, navigate, scroll, drag, wheel, tab events) + wait predicates.
- Every action: selector, textHint, roleHint, tabLid, timestamp, redacted flag.
- Predicates: urlChanged, domAdded, ariaLiveUpdated, textChanged, networkIdle, layoutStable, visualStable.

## Rules
- Always store textHint, roleHint, frame chain.
- Predicates scoped to nearest container.
- If domAdded + layoutStable in 2s, record both.
- NetworkIdle uses main-world fetch/XHR count.
- Redact sensitive input.
- Throttle scroll/wheel, coalesce drags.

## Testing
- Inspect JSON after recording.
- Replay in headed/headless.
- Break selector to force OCR path.
- CI validates schema and replays examples.