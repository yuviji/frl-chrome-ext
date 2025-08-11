type Debuggee = chrome.debugger.Debuggee;

export interface CDPReplayerOptions {
  tabId: number;
}

export class CDPReplayer {
  private readonly tabId: number;
  private readonly debuggee: Debuggee;
  private isAttached: boolean = false;
  private inflightRequests: number = 0;
  private lastActionName?: string;
  private lastActionSelectorRaw?: string;
  private lastActionTs?: number;
  private boundOnEvent?: (
    source: Debuggee,
    method: string,
    params?: object
  ) => void;
  private boundOnDetach?: (source: Debuggee) => void;

  constructor(options: CDPReplayerOptions) {
    this.tabId = options.tabId;
    this.debuggee = { tabId: this.tabId };
  }

  async attach(): Promise<void> {
    if (this.isAttached) return;
    await this.attachDebugger();
    await this.enableDomains();
    this.installEventHandlers();
    this.isAttached = true;
  }

  async detach(): Promise<void> {
    if (!this.isAttached) return;
    this.removeEventHandlers();
    await this.detachDebugger();
    this.isAttached = false;
  }

  // --- high-level API ---

  async play(trace: import("./types").TracePayload, thinkScale: number = 1): Promise<void> {
    const { steps } = trace;
    if (!this.isAttached) {
      await this.attach();
    }
    let previousTs: number | undefined;
    for (let idx = 0; idx < steps.length; idx += 1) {
      const step = steps[idx];
      this.logReplayStepStart(step, idx, steps.length);
      if (previousTs != null) {
        const rawDelta = Math.max(0, step.timestamp - previousTs);
        const maxThinkMs = 1500;
        const sleepMs = Math.min(maxThinkMs, Math.floor(rawDelta * thinkScale));
        if (sleepMs > 0) await this.sleep(sleepMs);
      }
      try {
        if ((step as any).kind === "action") {
          await this.applyAction(step as import("./types").ActionStep);
        } else if ((step as any).kind === "waitForPredicate") {
          await this.waitPredicate(step as import("./types").WaitPredicateStep);
        }
        this.logReplayStepEnd(step, idx, steps.length);
      } catch (err) {
        const message = this.formatStepError(step, err);
        // For action errors: log and continue. For wait errors: stop playback with friendly message.
        if ((step as any).kind === "action") {
          console.error(message);
          // continue
        } else {
          // Propagate to popup/background
          throw new Error(message);
        }
      }
      previousTs = step.timestamp;
    }
  }

  async applyAction(step: import("./types").ActionStep): Promise<void> {
    const action = step.action;
    const prevName = this.lastActionName;
    const prevSel = this.lastActionSelectorRaw;
    const prevTs = this.lastActionTs ?? 0;
    switch (action.name) {
      case "navigate": {
        await this.sendCommand("Page.navigate", { url: action.url });
        await this.waitForDomReady();
        this.lastActionName = action.name;
        this.lastActionSelectorRaw = step.selector?.selector;
        this.lastActionTs = Date.now();
        break;
      }
      case "click":
      case "dblclick": {
        const center = await this.resolveElementViewportCenter(step.selector);
        if (!center) throw new Error("Element not found for click");
        await this.mouseClick(center.x, center.y, action.name === "dblclick" ? 2 : 1);
        this.lastActionName = action.name;
        this.lastActionSelectorRaw = step.selector?.selector;
        this.lastActionTs = Date.now();
        break;
      }
      case "hover": {
        const center = await this.resolveElementViewportCenter(step.selector);
        if (!center) throw new Error("Element not found for hover");
        await this.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: center.x, y: center.y, pointerType: "mouse" });
        // Small dwell to allow hover-driven menus to render
        await this.sleep(120);
        this.lastActionName = action.name;
        this.lastActionSelectorRaw = step.selector?.selector;
        this.lastActionTs = Date.now();
        break;
      }
      case "type": {
        const center = await this.resolveElementViewportCenter(step.selector);
        if (!center) throw new Error("Element not found for type");
        // Focus only if not part of a rapid contiguous type/click sequence on the same element
        let shouldFocus = true;
        const sameTarget = prevSel && prevSel === step.selector?.selector;
        const recent = Date.now() - prevTs < 2000;
        if (sameTarget && recent && (prevName === "type" || prevName === "click")) {
          shouldFocus = false;
        }
        if (shouldFocus) {
          await this.mouseClick(center.x, center.y, 1);
        }
        if (!step.redacted && typeof action.text === "string" && action.text.length > 0) {
          await this.sendCommand("Input.insertText", { text: action.text });
        }
        this.lastActionName = action.name;
        this.lastActionSelectorRaw = step.selector?.selector;
        this.lastActionTs = Date.now();
        break;
      }
      case "press": {
        if (action.key === "Enter") {
          await this.sendCommand("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
            text: "\r",
            unmodifiedText: "\r",
          });
          await this.sendCommand("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "Enter",
            code: "Enter",
            windowsVirtualKeyCode: 13,
            nativeVirtualKeyCode: 13,
            text: "\r",
            unmodifiedText: "\r",
          });
        }
        this.lastActionName = action.name;
        this.lastActionSelectorRaw = step.selector?.selector;
        this.lastActionTs = Date.now();
        break;
      }
      case "scroll": {
        const dx = Number.isFinite(action.deltaX as any) ? (action.deltaX as number) : 0;
        const dy = Number.isFinite(action.deltaY as any) ? (action.deltaY as number) : 0;
        await this.sendCommand("Runtime.evaluate", {
          expression: `window.scrollBy(${Math.trunc(dx)}, ${Math.trunc(dy)})`,
          returnByValue: true,
          awaitPromise: true,
        });
        this.lastActionName = action.name;
        this.lastActionSelectorRaw = step.selector?.selector;
        this.lastActionTs = Date.now();
        break;
      }
      case "drag": {
        const start = await this.resolveElementViewportCenter(step.selector);
        const end = action.toSelector ? await this.resolveElementViewportCenter(action.toSelector) : (action.toX != null && action.toY != null ? { x: Math.round(action.toX), y: Math.round(action.toY) } : null);
        if (!start || !end) throw new Error("Drag endpoints not found");
        await this.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y, pointerType: "mouse" });
        await this.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", clickCount: 1, pointerType: "mouse" });
        // simple linear interpolation in a few steps
        const steps = 6;
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          const x = Math.round(start.x + (end.x - start.x) * t);
          const y = Math.round(start.y + (end.y - start.y) * t);
          await this.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x, y, pointerType: "mouse" });
          await this.sleep(16);
        }
        await this.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: end.x, y: end.y, button: "left", clickCount: 1, pointerType: "mouse" });
        this.lastActionName = action.name;
        this.lastActionSelectorRaw = step.selector?.selector;
        this.lastActionTs = Date.now();
        break;
      }
      case "highlight": {
        // Highlight is effectively a drag selection; we reuse drag
        const endSel = action.toSelector;
        const endPt = endSel ? await this.resolveElementViewportCenter(endSel) : (action.toX != null && action.toY != null ? { x: Math.round(action.toX), y: Math.round(action.toY) } : null);
        const start = await this.resolveElementViewportCenter(step.selector);
        if (!start || !endPt) throw new Error("Highlight endpoints not found");
        await this.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: start.x, y: start.y, pointerType: "mouse" });
        await this.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", x: start.x, y: start.y, button: "left", clickCount: 1, pointerType: "mouse" });
        await this.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", x: endPt.x, y: endPt.y, pointerType: "mouse" });
        await this.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", x: endPt.x, y: endPt.y, button: "left", clickCount: 1, pointerType: "mouse" });
        this.lastActionName = action.name;
        this.lastActionSelectorRaw = step.selector?.selector;
        this.lastActionTs = Date.now();
        break;
      }
      default:
        // No-op for unknown action
        break;
    }
  }

  async eval<T>(expression: string): Promise<T> {
    const result = await this.sendCommand<{
      result: { type: string; value?: T };
      exceptionDetails?: { text?: string; exception?: { description?: string; value?: any } };
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    // Basic exception surface if present
    if ((result as any)?.exceptionDetails) {
      const details = (result as any).exceptionDetails;
      const msg = details?.exception?.description || details?.text || "Runtime.evaluate exception";
      throw new Error(msg);
    }
    return (result as any)?.result?.value as T;
  }

  async waitUntil(
    condition: () => Promise<boolean> | boolean,
    timeoutMs: number = 5000,
    intervalMs: number = 100
  ): Promise<void> {
    const start = Date.now();
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const ok = await condition();
      if (ok) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error("waitUntil: timeout");
      }
      await this.sleep(intervalMs);
    }
  }

  async mouseClick(x: number, y: number, clicks: number = 1): Promise<void> {
    // Move first
    await this.sendCommand("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x,
      y,
      pointerType: "mouse",
    });

    for (let i = 0; i < clicks; i += 1) {
      await this.sendCommand("Input.dispatchMouseEvent", {
        type: "mousePressed",
        x,
        y,
        button: "left",
        clickCount: i + 1,
        pointerType: "mouse",
      });
      await this.sendCommand("Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x,
        y,
        button: "left",
        clickCount: i + 1,
        pointerType: "mouse",
      });
    }
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // --- internals ---

  private attachDebugger(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        chrome.debugger.attach(this.debuggee, "1.3", () => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            reject(new Error(lastErr.message));
            return;
          }
          resolve();
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  private detachDebugger(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        chrome.debugger.detach(this.debuggee, () => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            // If already detached, treat as success to be safe
            if (/No target with given id|not attached/i.test(lastErr.message ?? "")) {
              resolve();
              return;
            }
            reject(new Error(lastErr.message));
            return;
          }
          resolve();
        });
      } catch (err) {
        // Best-effort safe detach
        resolve();
      }
    });
  }

  private async enableDomains(): Promise<void> {
    await Promise.all([
      this.sendCommand("Page.enable"),
      this.sendCommand("DOM.enable"),
      this.sendCommand("Runtime.enable"),
      this.sendCommand("Network.enable", { maxTotalBufferSize: 50_000_000 }),
    ]);
  }

  private installEventHandlers(): void {
    this.boundOnEvent = (source, method, params) => {
      if (!source || source.tabId !== this.tabId) return;
      if (method === "Network.requestWillBeSent") {
        this.inflightRequests += 1;
      } else if (method === "Network.loadingFinished" || method === "Network.loadingFailed") {
        this.inflightRequests = Math.max(0, this.inflightRequests - 1);
      }
    };
    this.boundOnDetach = (source) => {
      if (!source || source.tabId !== this.tabId) return;
      this.isAttached = false;
    };
    chrome.debugger.onEvent.addListener(this.boundOnEvent);
    chrome.debugger.onDetach.addListener(this.boundOnDetach);
  }

  private removeEventHandlers(): void {
    if (this.boundOnEvent) {
      try {
        chrome.debugger.onEvent.removeListener(this.boundOnEvent);
      } catch {}
      this.boundOnEvent = undefined;
    }
    if (this.boundOnDetach) {
      try {
        chrome.debugger.onDetach.removeListener(this.boundOnDetach);
      } catch {}
      this.boundOnDetach = undefined;
    }
  }

  private async waitForDomReady(timeoutMs: number = 10000): Promise<void> {
    await this.waitUntil(async () => {
      const state = await this.eval<string>("document.readyState");
      return state === "interactive" || state === "complete";
    }, timeoutMs, 100);
  }

  private async resolveElementViewportCenter(
    selector: import("./types").BuiltSelector
  ): Promise<{ x: number; y: number } | null> {
    const original = selector?.selector ?? "";
    const isAriaPseudo = /(^|\s)role\s*=/.test(original) && /(^|\s)name(~|)?\s*=/.test(original);
    if (isAriaPseudo) {
      const center = await this.resolveAriaPseudoCenter(original);
      if (center) return center;
    }
    const raw = this.translateAriaPseudo(original) || original;
    const expr = `(() => {\n` +
      `  const raw = ${JSON.stringify(raw)};\n` +
      `  function byXPath(path) {\n` +
      `    try {\n` +
      `      const res = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);\n` +
      `      return res.singleNodeValue;\n` +
      `    } catch (e) { return null; }\n` +
      `  }\n` +
      `  function byQuery(q) {\n` +
      `    try { return document.querySelector(q); } catch (e) { return null; }\n` +
      `  }\n` +
      `  let el = null;\n` +
      `  if (raw && (/^\\/\\//.test(raw) || raw.startsWith('('))) {\n` +
      `    el = byXPath(raw);\n` +
      `  }\n` +
      `  if (!el) { el = byQuery(raw); }\n` +
      `  if (!el || !(el instanceof Element)) return null;\n` +
      `  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch {}\n` +
      `  const r = el.getBoundingClientRect();\n` +
      `  return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };\n` +
      `})()`;
    try {
      return await this.eval<{ x: number; y: number } | null>(expr);
    } catch {
      return null;
    }
  }

  private async resolveAriaPseudoCenter(raw: string): Promise<{ x: number; y: number } | null> {
    const fn = `function(sel){
      function parse(s){
        try {
          var mRole = s.match(/(?:^|\s)role=([^\s]+)/);
          var mContains = s.match(/(?:^|\s)name~=([\s\S]+)/);
          var mExact = mContains ? null : s.match(/(?:^|\s)name=([\s\S]+)/);
          var role = mRole ? mRole[1] : '';
          var name = (mContains ? mContains[1] : (mExact ? mExact[1] : '')).trim();
          var contains = !!mContains;
          return { role: role, name: name, contains: contains };
        } catch(e){ return { role:'', name:'', contains:false }; }
      }
      function visible(n){ try { var r=n.getBoundingClientRect(); if (!r || r.width<=0 || r.height<=0) return false; var cs=getComputedStyle(n); return cs && cs.visibility!=='hidden' && cs.display!=='none'; } catch(e){ return true; } }
      function accName(n){ try { var a=n.getAttribute('aria-label'); if (a && a.trim()) return a.trim(); var t=(n.textContent||'').replace(/\s+/g,' ').trim(); return t; } catch(e){ return ''; } }
      var p = parse(sel); if (!p.role || !p.name) return null;
      var nodes = Array.from(document.querySelectorAll('[role="'+p.role+'"]'));
      for (var i=0;i<nodes.length;i++) {
        var n = nodes[i]; var nm = accName(n);
        if ((p.contains && nm.indexOf(p.name) >= 0) || (!p.contains && nm === p.name)) {
          if (!visible(n)) continue;
          try { n.scrollIntoView({ block: 'center', inline: 'center' }); } catch(e){}
          var r = n.getBoundingClientRect();
          return { x: Math.round(r.left + r.width/2), y: Math.round(r.top + r.height/2) };
        }
      }
      return null;
    }`;
    try { return await this.callFunctionOn(fn, [raw]); } catch { return null; }
  }

  // Wait for a recorded predicate to be satisfied on the page without fixed sleeps
  async waitPredicate(step: import("./types").WaitPredicateStep): Promise<void> {
    // Cap per-wait timeout at 30s
    const timeoutMs = 30000;
    const pollMs = 120;
    // Surface a clear log if container selector is not supported/malformed for replay resolution
    this.warnIfMalformedContainer(step.container);
    switch (step.predicate) {
      case "urlChanged": {
        const baseline = await this.eval<string>("location.href");
        try {
          await this.waitUntil(async () => {
            const cur = await this.eval<string>("location.href");
            return cur !== baseline;
          }, timeoutMs, pollMs);
        } catch (e) {
          throw new Error(this.friendlyWaitTimeoutMessage(step, timeoutMs));
        }
        break;
      }
      case "domAdded": {
        // If container is a contenteditable editor (e.g., ProseMirror input), DOM additions
        // typically occur elsewhere in the page (the transcript), so skip this wait.
        if (await this.isContentEditableContainer(step.container)) {
          console.warn(`[FRL] skip domAdded for contenteditable container: ${step.container?.selector || ''}`);
          break;
        }
        try {
          const ok = await this.waitForDomAddedObserver(step.container, timeoutMs);
          if (!ok) {
            throw new Error("domAdded timeout");
          }
        } catch (e) {
          throw new Error(this.friendlyWaitTimeoutMessage(step, timeoutMs));
        }
        break;
      }
      case "textChanged": {
        // If the last action was a direct type into the same container, the change likely already
        // occurred synchronously when we dispatched Input.insertText. Consider it satisfied.
        const containerSel = step.container?.selector || "";
        if (this.lastActionName === "type" && containerSel && containerSel === this.lastActionSelectorRaw) {
          return;
        }
        try {
          const ok = await this.waitForTextChangeObserver(step.container, timeoutMs);
          if (!ok?.changed) {
            const textPreview = (ok?.currentText || "").slice(0, 160);
            const htmlPreview = (ok?.currentHtml || "").slice(0, 160);
            const baseMsg = this.friendlyWaitTimeoutMessage(step, timeoutMs);
            throw new Error(`${baseMsg}. Current text: ${JSON.stringify(textPreview)}${htmlPreview ? `, html: ${JSON.stringify(htmlPreview)}` : ""}`);
          }
        } catch (e) {
          if (e instanceof Error) throw e;
          throw new Error(this.friendlyWaitTimeoutMessage(step, timeoutMs));
        }
        break;
      }
      case "ariaLiveUpdated": {
        const liveExpr = this.buildAriaLiveNonEmptyExpr(step.container);
        try {
          await this.waitUntil(async () => {
            const ok = await this.eval<boolean>(liveExpr);
            return Boolean(ok);
          }, timeoutMs, pollMs);
        } catch (e) {
          throw new Error(this.friendlyWaitTimeoutMessage(step, timeoutMs));
        }
        break;
      }
      case "layoutStable": {
        try {
          const ok = await this.waitForLayoutStableObserver(step.container, timeoutMs, 800);
          if (!ok) {
            throw new Error(this.friendlyWaitTimeoutMessage(step, timeoutMs));
          }
        } catch (e) {
          if (e instanceof Error) throw e;
          throw new Error(this.friendlyWaitTimeoutMessage(step, timeoutMs));
        }
        break;
      }
      default:
        // Unknown predicate → no-op
        break;
    }
  }

  // --- expression builders for container-scoped evaluations ---
  private buildContainerResolveExpr(container?: import("./types").BuiltSelector): string {
    // Returns an expression that yields an Element-like container (defaults to document.body or documentElement)
    if (!container) {
      return "(document.body || document.documentElement)";
    }
    const rawSel = this.translateAriaPseudo(String(container.selector || "")) || String(container.selector || "");
    const raw = JSON.stringify(rawSel);
    const expr =
      "(() => {" +
      "  const raw = " + raw + ";" +
      "  function byXPath(path){ try { const res = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); return res.singleNodeValue; } catch(e){ return null; } }" +
      "  function byQuery(q){ try { return document.querySelector(q); } catch(e){ return null; } }" +
      "  let el = null;" +
      "  if (raw && (/^\\\\\//.test(raw) || raw.startsWith('('))) { el = byXPath(raw); }" +
      "  if (!el) el = byQuery(raw);" +
      "  if (el && el.nodeType === 1) return el;" +
      "  return (document.body || document.documentElement);" +
      "})()";
    return expr;
  }

  private buildDomCountExpr(container?: import("./types").BuiltSelector): string {
    const root = this.buildContainerResolveExpr(container);
    return (
      "(() => {" +
      `  const root = ${root};` +
      "  const scope = (root && typeof root.querySelectorAll === 'function') ? root : document;" +
      "  try { return scope.querySelectorAll('*').length; } catch(e) { return 0; }" +
      "})()"
    );
  }

  private buildInnerTextHashExpr(container?: import("./types").BuiltSelector): string {
    const root = this.buildContainerResolveExpr(container);
    return (
      "(() => {" +
      `  const root = ${root};` +
      "  const el = (root && root.nodeType === 1) ? root : (document.body || document.documentElement);" +
      "  let text = '';" +
      "  try { text = (el && el.innerText != null) ? String(el.innerText) : String((document.body && document.body.innerText) || ''); } catch(e) { text=''; }" +
      "  let h = 0 >>> 0;" +
      "  for (let i = 0; i < text.length; i++) { h = (Math.imul(h, 31) + text.charCodeAt(i)) >>> 0; }" +
      "  return h >>> 0;" +
      "})()"
    );
  }

  private buildAriaLiveNonEmptyExpr(container?: import("./types").BuiltSelector): string {
    const root = this.buildContainerResolveExpr(container);
    return (
      "(() => {" +
      `  const root = ${root};` +
      "  const scope = (root && typeof root.querySelectorAll === 'function') ? root : document;" +
      "  try {" +
      "    const nodes = Array.from(scope.querySelectorAll('[aria-live]'));" +
      "    for (const n of nodes) { const v = (n.getAttribute('aria-live') || '').toLowerCase(); if (v && v !== 'off') { const t = (n.textContent || '').trim(); if (t.length > 0) return true; } }" +
      "    return false;" +
      "  } catch(e) { return false; }" +
      "})()"
    );
  }

  private buildBoundingSizeExpr(container?: import("./types").BuiltSelector): string {
    const root = this.buildContainerResolveExpr(container);
    return (
      "(() => {" +
      `  const root = ${root};` +
      "  let el = root;" +
      "  if (!el || el.nodeType !== 1) el = document.body || document.documentElement;" +
      "  try { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; } catch(e) { return { w: -1, h: -1 }; }" +
      "})()"
    );
  }

  private sendCommand<R = any>(
    method: string,
    params?: Record<string, unknown>
  ): Promise<R> {
    return new Promise((resolve, reject) => {
      try {
        chrome.debugger.sendCommand(this.debuggee, method as any, params as any, (result?: any) => {
          const lastErr = chrome.runtime.lastError;
          if (lastErr) {
            reject(new Error(lastErr.message));
            return;
          }
          resolve(result as R);
        });
      } catch (err) {
        reject(err);
      }
    });
  }

  // Execute a function in page context using Runtime.callFunctionOn to avoid string concatenation issues
  private async callFunctionOn<T>(
    fnDeclaration: string,
    args: any[]
  ): Promise<T> {
    // Create a handle to the global document element to scope the call
    const { result: docHandle } = await this.sendCommand<any>("Runtime.evaluate", {
      expression: "document",
      objectGroup: "frl",
      includeCommandLineAPI: false,
      silent: true,
    });
    const objectId = docHandle?.objectId;
    try {
      const resp = await this.sendCommand<any>("Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: fnDeclaration,
        arguments: args.map((v) => ({ value: v })),
        returnByValue: true,
        awaitPromise: true,
      });
      if (resp?.exceptionDetails) {
        const msg = resp.exceptionDetails?.exception?.description || resp.exceptionDetails?.text || "callFunctionOn exception";
        throw new Error(msg);
      }
      return resp?.result?.value as T;
    } finally {
      // Cleanup the handle
      try { await this.sendCommand("Runtime.releaseObject", { objectId }); } catch {}
    }
  }

  // Wait for text content changes using a MutationObserver inside the page
  private async waitForTextChangeObserver(
    container: import("./types").BuiltSelector | undefined,
    timeoutMs: number
  ): Promise<{ changed: boolean; currentText?: string; currentHtml?: string }> {
    const selector = container?.selector ?? "";
    // We accept either XPath-like or CSS selector input
    const fn = `function(selector, timeoutMs) {
      return new Promise((resolve) => {
        var start = Date.now();
        function byXPath(path) {
          try {
            var res = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
            return res.singleNodeValue;
          } catch (e) { return null; }
        }
        function byQuery(q) {
          try { return document.querySelector(q); } catch (e) { return null; }
        }
        var el = null;
        if (selector && (/^\\//.test(selector) || selector.charAt(0) === '(')) {
          el = byXPath(selector);
        }
        if (!el) el = byQuery(selector);
        if (!el || el.nodeType !== 1) el = document.body || document.documentElement;
        var baseline = '';
        try { baseline = (el.textContent || '').trim(); } catch (e) { baseline = ''; }
        var observer = new MutationObserver(function() {
          var cur = '';
          try { cur = (el.textContent || '').trim(); } catch (e) { cur = ''; }
          if (cur !== baseline) {
            try { observer.disconnect(); } catch (e) {}
            resolve({ changed: true, currentText: cur, currentHtml: String(el.innerHTML || '') });
          }
        });
        try { observer.observe(el, { subtree: true, childList: true, characterData: true, attributes: true }); } catch (e) {}
        // Poll as a fallback in case observer misses changes
        var interval = setInterval(function() {
          var cur = '';
          try { cur = (el.textContent || '').trim(); } catch (e) { cur = ''; }
          if (cur !== baseline) {
            clearInterval(interval);
            try { observer.disconnect(); } catch (e) {}
            resolve({ changed: true, currentText: cur, currentHtml: String(el.innerHTML || '') });
          }
          if ((Date.now() - start) > timeoutMs) {
            clearInterval(interval);
            try { observer.disconnect(); } catch (e) {}
            resolve({ changed: false, currentText: cur, currentHtml: String(el.innerHTML || '') });
          }
        }, 120);
      });
    }`;

    // Use callFunctionOn with selector and timeout as values
    return await this.callFunctionOn(fn, [selector, timeoutMs]);
  }

  private async waitForLayoutStableObserver(
    container: import("./types").BuiltSelector | undefined,
    timeoutMs: number,
    idleMs: number
  ): Promise<boolean> {
    const selector = container?.selector ?? "";
    const fn = `function(selector, timeoutMs, idleMs){
      return new Promise(function(resolve){
        var start = Date.now();
        function byXPath(path){ try{ var r=document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); return r.singleNodeValue; }catch(e){ return null; } }
        function byQuery(q){ try{ return document.querySelector(q); }catch(e){ return null; } }
        var el = null; if (selector && (/^\\//.test(selector) || selector.charAt(0)==='(')) { el = byXPath(selector); }
        if (!el) el = byQuery(selector);
        if (!el || el.nodeType !== 1) el = document.body || document.documentElement;
        // Heuristic: if the root is a small/animated/button-like control, escalate to documentElement
        function isButtonLike(node){ try{ var tag=(node.tagName||'').toLowerCase(); if (tag==='button') return true; var role=(node.getAttribute('role')||'').toLowerCase(); if (role.indexOf('button')>=0) return true; return !!node.closest && !!node.closest('button'); }catch(e){ return false; } }
        function hasActiveAnimations(node){ try{ var a = (node.getAnimations && node.getAnimations()) || []; return a.length>0; }catch(e){ return false; } }
        function isTiny(node){ try{ var r=node.getBoundingClientRect(); return (r.width*r.height) < 2500; }catch(e){ return false; } }
        if (isButtonLike(el) || hasActiveAnimations(el) || isTiny(el)) { el = document.documentElement; }

        var lastRect = null; var lastChange = Date.now();
        function rectOf(node){ try{ var r=node.getBoundingClientRect(); return [Math.round(r.left),Math.round(r.top),Math.round(r.width),Math.round(r.height)]; }catch(e){ return null; } }
        function changed(a,b){ if(!a||!b) return true; for(var i=0;i<4;i++){ if(a[i]!==b[i]) return true; } return false; }

        var obs = new MutationObserver(function(){ lastChange = Date.now(); });
        try{ obs.observe(el, { subtree:true, attributes:true, childList:true, characterData:true }); }catch(e){}

        var iv = setInterval(function(){
          var rect = rectOf(el);
          if (changed(rect, lastRect)) { lastRect = rect; lastChange = Date.now(); }
          if ((Date.now()-lastChange) >= idleMs) { clearInterval(iv); try{obs.disconnect();}catch(e){} resolve(true); }
          if ((Date.now()-start) > timeoutMs) { clearInterval(iv); try{obs.disconnect();}catch(e){} resolve(false); }
        }, 120);
      });
    }`;
    return await this.callFunctionOn<boolean>(fn, [selector, timeoutMs, idleMs]);
  }

  private async waitForDomAddedObserver(
    container: import("./types").BuiltSelector | undefined,
    timeoutMs: number
  ): Promise<boolean> {
    const selector = container?.selector ?? "";
    const fn = `function(selector, timeoutMs){
      return new Promise(function(resolve){
        var start = Date.now();
        function byXPath(path){ try{ var r=document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); return r.singleNodeValue; }catch(e){ return null; } }
        function byQuery(q){ try{ return document.querySelector(q); }catch(e){ return null; } }
        var el = null; if (selector && (/^\\//.test(selector) || selector.charAt(0)==='(')) { el = byXPath(selector); }
        if (!el) el = byQuery(selector);
        if (!el || el.nodeType !== 1) el = document.body || document.documentElement;
        // If the element is a contenteditable/editor, or looks too small/sentinel-like, use the document root as the scope
        function isTiny(node){ try{ var r=node.getBoundingClientRect(); return (r.width*r.height) < 2500; }catch(e){ return false; } }
        function isSentinel(node){ try{ var role=(node.getAttribute('role')||'').toLowerCase(); if (role==='presentation'||role==='none') return true; var id=(node.id||''); var cls=(node.className||''); return /(^overlay-|^modal-backdrop|^tooltip-|^toast-)/.test(id) || /(sentinel|backdrop|overlay|tooltip|toast)/i.test(cls); }catch(e){ return false; } }
        try { if ((el as any).isContentEditable === true || (el.getAttribute && el.getAttribute('contenteditable')) || isTiny(el) || isSentinel(el)) { el = document.documentElement; } } catch(e) {}
        function hasAddedElement(m){ try{ if (!m) return false; if (m.addedNodes && m.addedNodes.length){ for (var i=0;i<m.addedNodes.length;i++){ var n=m.addedNodes[i]; if (n && n.nodeType === 1) return true; } } return false; }catch(e){ return false; } }
        function textOf(node){ try{ return String((node.textContent||'')).trim(); }catch(e){ return ''; } }
        function htmlOf(node){ try{ return String(node.innerHTML||''); }catch(e){ return ''; } }
        var baselineCount = 0; var baselineText = ''; var baselineHtml = '';
        try { baselineCount = (el.querySelectorAll && el.querySelectorAll('*').length) || 0; } catch(e) { baselineCount = 0; }
        baselineText = textOf(el); baselineHtml = htmlOf(el);
        var obs = new MutationObserver(function(muts){
          for (var i=0;i<muts.length;i++) {
            if (hasAddedElement(muts[i])) { try{ obs.disconnect(); }catch(e){} resolve(true); return; }
          }
          var curText = textOf(el); var curHtml = htmlOf(el);
          if (curText !== baselineText || curHtml !== baselineHtml) { try{ obs.disconnect(); }catch(e){} resolve(true); return; }
        });
        try { obs.observe(el, { subtree:true, childList:true, characterData:true, attributes:true }); } catch(e) {}
        var iv = setInterval(function(){
          var cur = 0; try { cur = (el.querySelectorAll && el.querySelectorAll('*').length) || 0; } catch(e) { cur = 0; }
          if (cur > baselineCount) { clearInterval(iv); try{ obs.disconnect(); }catch(e){} resolve(true); return; }
          var curText = textOf(el); var curHtml = htmlOf(el);
          if (curText !== baselineText || curHtml !== baselineHtml) { clearInterval(iv); try{ obs.disconnect(); }catch(e){} resolve(true); return; }
          if ((Date.now()-start) > timeoutMs) { clearInterval(iv); try{ obs.disconnect(); }catch(e){} resolve(false); }
        }, 120);
      });
    }`;
    return await this.callFunctionOn<boolean>(fn, [selector, timeoutMs]);
  }

  // --- helpers for friendly messages & validation ---
  private friendlyPredicateName(pred: string): string {
    switch (pred) {
      case "urlChanged":
        return "navigation";
      case "domAdded":
        return "content to appear";
      case "ariaLiveUpdated":
        return "announcement";
      case "textChanged":
        return "text update";
      case "layoutStable":
        return "page to settle";
      default:
        return pred;
    }
  }

  private friendlyWaitTimeoutMessage(step: import("./types").WaitPredicateStep, timeoutMs: number): string {
    const friendly = this.friendlyPredicateName(String(step?.predicate ?? ""));
    const where = step?.container?.selector ? ` in container: ${JSON.stringify(step.container.selector)}` : "";
    return `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for ${friendly}${where}`;
  }

  private warnIfMalformedContainer(container?: import("./types").BuiltSelector): void {
    const raw = container?.selector ?? "";
    if (!raw) return;
    // Warn only for pseudo syntax we translate (role=..., name=...), not for valid CSS like [role="presentation"]
    const isPseudo = /(?:^|\s)role\s*=|(?:^|\s)name(?:~)?\s*=/.test(raw);
    const translated = this.translateAriaPseudo(raw);
    if (isPseudo && !translated) {
      console.error(`[FRL] Malformed/unsupported container selector for replay: ${raw}. Falling back to document root.`);
    }
  }

  private formatStepError(step: any, err: unknown): string {
    const base = (err instanceof Error ? err.message : String(err)) || "Unknown error";
    if (!step || typeof step !== "object") return base;
    if ((step as any).kind === "action") {
      const nm = (step as any)?.action?.name ?? "action";
      const sel = (step as any)?.selector?.selector;
      return `Action ${nm} failed${sel ? ` on ${JSON.stringify(sel)}` : ""}: ${base}`;
    }
    if ((step as any).kind === "waitForPredicate") {
      const pred = (step as any)?.predicate ?? "predicate";
      const sel = (step as any)?.container?.selector;
      return `Wait for ${this.friendlyPredicateName(String(pred))} failed${sel ? ` in ${JSON.stringify(sel)}` : ""}: ${base}`;
    }
    return base;
  }

  // Translate our pseudo aria selector syntax (e.g., "role=button name=Close" or "name~=Close") to CSS
  private translateAriaPseudo(raw: string): string | null {
    if (!raw) return null;
    if (!/(^|\s)role\s*=|(^|\s)name(~|)\s*=/.test(raw)) return null;
    try {
      const roleMatch = raw.match(/(?:^|\s)role=([^\s]+)/);
      const nameContainsMatch = raw.match(/(?:^|\s)name~=([^].*)$/);
      const nameExactMatch = !nameContainsMatch ? raw.match(/(?:^|\s)name=([^].*)$/) : null;
      const name = (nameContainsMatch ? nameContainsMatch[1] : nameExactMatch ? nameExactMatch[1] : "").trim();
      const contains = !!nameContainsMatch;
      if (!name) return null;
      // Unescape simple backslash-escaped quotes
      const cleaned = name.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      const op = contains ? "*=" : "=";
      // Do not enforce role attribute since many elements have implicit roles (e.g., <button>)
      return `[aria-label${op}${JSON.stringify(cleaned)}]`;
    } catch {
      return null;
    }
  }

  private logReplayStepStart(step: any, index: number, total: number): void {
    try {
      if (!step || typeof step !== "object") return;
      const prefix = `[FRL][replay] ${index + 1}/${total}`;
      if (step.kind === "action") {
        const nm = step.action?.name;
        const sel = this.prettySelector(step.selector);
        // eslint-disable-next-line no-console
        console.log(`${prefix} action: ${nm}${sel ? ` → ${sel}` : ""}`);
      } else if (step.kind === "waitForPredicate") {
        const pred = step.predicate;
        const where = this.prettySelector(step.container);
        // eslint-disable-next-line no-console
        console.log(`${prefix} wait: ${this.friendlyPredicateName(String(pred))}${where ? ` in ${where}` : ""}`);
      }
    } catch {}
  }

  private logReplayStepEnd(step: any, index: number, total: number): void {
    try {
      const prefix = `[FRL][replay] ${index + 1}/${total}`;
      // eslint-disable-next-line no-console
      console.log(`${prefix} ✓ done`);
    } catch {}
  }

  private prettySelector(sel?: import("./types").BuiltSelector): string {
    try {
      if (!sel) return "";
      const text = (sel as any).textHint as string | undefined;
      const role = (sel as any).roleHint as string | undefined;
      if (text && role) return `${role} “${this.truncate(text, 60)}”`;
      if (text) return `“${this.truncate(text, 60)}”`;
      if (role) return role;
      const raw = String((sel as any).selector ?? "");
      return raw.length > 120 ? raw.slice(0, 117) + "…" : raw;
    } catch { return ""; }
  }

  private truncate(text: string, max = 120): string {
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  }

  private async isContentEditableContainer(container?: import("./types").BuiltSelector): Promise<boolean> {
    const selector = container?.selector ?? "";
    const fn = `function(selector){
      function byXPath(path){ try{ var r=document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); return r.singleNodeValue; }catch(e){ return null; } }
      function byQuery(q){ try{ return document.querySelector(q); }catch(e){ return null; } }
      var el = null; if (selector && (/^\\//.test(selector) || selector.charAt(0)==='(')) { el = byXPath(selector); }
      if (!el) el = byQuery(selector);
      if (!el || el.nodeType !== 1) return false;
      try { if ((el as any).isContentEditable === true) return true; } catch(e) {}
      try { var ce = el.getAttribute && el.getAttribute('contenteditable'); if (ce && ce !== 'false') return true; } catch(e) {}
      return false;
    }`;
    try { return await this.callFunctionOn<boolean>(fn, [selector]); } catch { return false; }
  }
}

export default CDPReplayer;

