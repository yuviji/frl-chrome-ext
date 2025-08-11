type Debuggee = chrome.debugger.Debuggee;

export interface CDPReplayerOptions {
  tabId: number;
}

export class CDPReplayer {
  private readonly tabId: number;
  private readonly debuggee: Debuggee;
  private isAttached: boolean = false;
  private inflightRequests: number = 0;
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
    for (const step of steps) {
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
    switch (action.name) {
      case "navigate": {
        await this.sendCommand("Page.navigate", { url: action.url });
        await this.waitForDomReady();
        break;
      }
      case "click":
      case "dblclick": {
        const center = await this.resolveElementViewportCenter(step.selector);
        if (!center) throw new Error("Element not found for click");
        await this.mouseClick(center.x, center.y, action.name === "dblclick" ? 2 : 1);
        break;
      }
      case "type": {
        const center = await this.resolveElementViewportCenter(step.selector);
        if (!center) throw new Error("Element not found for type");
        // Click to focus first
        await this.mouseClick(center.x, center.y, 1);
        if (!step.redacted && typeof action.text === "string" && action.text.length > 0) {
          await this.sendCommand("Input.insertText", { text: action.text });
        }
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
      exceptionDetails?: unknown;
    }>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    // Basic exception surface if present
    if ((result as any)?.exceptionDetails) {
      throw new Error("Runtime.evaluate exception");
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
    const raw = selector?.selector ?? "";
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
        const countExpr = this.buildDomCountExpr(step.container);
        const baseline = await this.eval<number>(countExpr);
        try {
          await this.waitUntil(async () => {
            const cur = await this.eval<number>(countExpr);
            return Number(cur) > Number(baseline);
          }, timeoutMs, pollMs);
        } catch (e) {
          throw new Error(this.friendlyWaitTimeoutMessage(step, timeoutMs));
        }
        break;
      }
      case "textChanged": {
        const hashExpr = this.buildInnerTextHashExpr(step.container);
        const baseline = await this.eval<number>(hashExpr);
        try {
          await this.waitUntil(async () => {
            const cur = await this.eval<number>(hashExpr);
            return Number(cur) !== Number(baseline);
          }, timeoutMs, pollMs);
        } catch (e) {
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
        const sizeExpr = this.buildBoundingSizeExpr(step.container);
        let lastW = -1;
        let lastH = -1;
        let lastChange = Date.now();
        try {
          await this.waitUntil(async () => {
            const sz = await this.eval<{ w: number; h: number }>(sizeExpr);
            const w = Math.trunc((sz as any)?.w ?? -1);
            const h = Math.trunc((sz as any)?.h ?? -1);
            if (w !== lastW || h !== lastH) {
              lastW = w;
              lastH = h;
              lastChange = Date.now();
              return false;
            }
            return Date.now() - lastChange >= 800;
          }, timeoutMs, pollMs);
        } catch (e) {
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
    const raw = JSON.stringify(String(container.selector || ""));
    const expr =
      "(() => {" +
      "  const raw = " + raw + ";" +
      "  function byXPath(path){ try { const res = document.evaluate(path, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null); return res.singleNodeValue; } catch(e){ return null; } }" +
      "  function byQuery(q){ try { return document.querySelector(q); } catch(e){ return null; } }" +
      "  let el = null;" +
      "  if (raw && (/^\\\\\//.test(raw) || raw.startsWith('('))) { el = byXPath(raw); }" +
      "  if (!el) el = byQuery(raw);" +
      "  if (el && el.nodeType === Node.ELEMENT_NODE) return el;" +
      "  return (document.body || document.documentElement);" +
      "})()";
    return expr;
  }

  private buildDomCountExpr(container?: import("./types").BuiltSelector): string {
    const root = this.buildContainerResolveExpr(container);
    return (
      "(() => {" +
      `  const root = ${root};` +
      "  const scope = (root && root.querySelectorAll) ? root : document;" +
      "  try { return scope.querySelectorAll('*').length; } catch(e) { return 0; }" +
      "})()"
    );
  }

  private buildInnerTextHashExpr(container?: import("./types").BuiltSelector): string {
    const root = this.buildContainerResolveExpr(container);
    return (
      "(() => {" +
      `  const root = ${root};` +
      "  const el = (root && root.nodeType === Node.ELEMENT_NODE) ? root : (document.body || document.documentElement);" +
      "  let text = '';" +
      "  try { text = (el && el.innerText != null) ? String(el.innerText) : String(document.body?.innerText || ''); } catch(e) { text=''; }" +
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
      "  const scope = (root && root.querySelectorAll) ? root : document;" +
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
      "  if (!el || el.nodeType !== Node.ELEMENT_NODE) el = document.body || document.documentElement;" +
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
    // Our replayer only supports CSS selectors or XPath-like paths. ARIA pseudo-selectors are not supported.
    const looksLikeXPath = /^\//.test(raw) || raw.startsWith("(");
    const looksLikeAriaPseudo = /\brole\s*=|\bname\s*=/.test(raw);
    if (!looksLikeXPath && looksLikeAriaPseudo) {
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
}

export default CDPReplayer;

