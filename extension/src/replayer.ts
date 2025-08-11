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
    const actionSteps = steps.filter((s): s is import("./types").ActionStep => s && (s as any).kind === "action");
    let previousTs: number | undefined;
    for (const step of actionSteps) {
      if (previousTs != null) {
        const rawDelta = Math.max(0, step.timestamp - previousTs);
        const maxThinkMs = 1500;
        const sleepMs = Math.min(maxThinkMs, Math.floor(rawDelta * thinkScale));
        if (sleepMs > 0) await this.sleep(sleepMs);
      }
      await this.applyAction(step);
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
}

export default CDPReplayer;

