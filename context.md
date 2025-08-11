Filename: context-replay-in-extension.md

# Context: Fix Recorder Reds & Add In-Extension Replayer (CDP)

## Goal
Make your existing MV3 **recorder** produce cleaner, reliable traces and add a built-in **replayer** inside the extension using Chrome DevTools Protocol (`chrome.debugger`). No Python required.

## Current Recorder (yours)
- Actions: click/dblclick/type/press/scroll/navigate
- Predicates: urlChanged, domAdded, ariaLiveUpdated, textChanged, layoutStable
- Selector strategy: aria > data-* > xpath > compact css
- Deep-tree: `shadowChain` + `frameChain`
- Output types: `BuiltSelector`, `ActionStep`, `WaitPredicateStep`, `TracePayload`
- Messaging: `FRL_*` chain (Popup ⇒ Background ⇒ Content)

## Must-Fix “Reds”
1) **Never emit `waitForPredicate: "urlChanged"`** unless `location.href` actually changed during the observation window.
2) **De-duplicate consecutive identical `waitForPredicate` steps** (same predicate + same container).
3) **Stamp `tabLid` on every step**. Use default `1` now (plumb real logical IDs later).

## Replayer (new, inside extension)
- Lives in **background** (has `debugger` permission).
- Class `CDPReplayer`:
  - `attach() / detach()`
  - `play(trace, thinkScale=1)`
  - Actions: navigate, click, dblclick, type (skip when `redacted`), press Enter, scroll
  - Waits for predicates using `Runtime.evaluate`/`Network.*` and DOM polling:
    - urlChanged, domAdded, textChanged, ariaLiveUpdated, layoutStable
    - (optional later: networkIdle by tracking `Network` inflight)
- Simple **Popup “Play JSON”**: file picker + Play/Stop + ThinkTime slider.

## Permissions
- Add: `"debugger", "tabs", "webNavigation", "scripting", "storage"`
- Host permissions: `"<all_urls>"`

## Testing
- Re-record a flow that previously emitted bad `urlChanged` → verify it’s gone.
- Export JSON → confirm no back-to-back duplicate waits; all steps have `tabLid: 1`.
- Load JSON in popup → Play → observe actions + waits working. Stop interrupts.

## Nice-to-have (later)
- Frame/shadow robust resolution in CDP.
- In-extension OCR fallback (Tesseract.js via offscreen document) if selectors fail.