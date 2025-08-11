import { describe, it, expect, beforeEach, vi } from "vitest";
import { CDPReplayer } from "./replayer";
import type { ActionStep, TracePayload } from "./types";

type SentCommand = { method: string; params: any };

declare global {
  // eslint-disable-next-line no-var
  var chrome: any;
}

describe("CDPReplayer", () => {
  let sendCalls: SentCommand[];
  let attachCount = 0;
  let detachCount = 0;

  beforeEach(() => {
    sendCalls = [];
    attachCount = 0;
    detachCount = 0;

    globalThis.chrome = {
      runtime: {
        lastError: undefined as any,
      },
      debugger: {
        attach: (_debuggee: any, _version: string, cb: () => void) => {
          attachCount += 1;
          cb();
        },
        detach: (_debuggee: any, cb: () => void) => {
          detachCount += 1;
          cb();
        },
        sendCommand: (_debuggee: any, method: string, params: any, cb: (result?: any) => void) => {
          sendCalls.push({ method, params });
          if (method === "Runtime.evaluate") {
            const expr = String(params?.expression ?? "");
            if (expr === "document.readyState") {
              cb({ result: { type: "string", value: "complete" } });
              return;
            }
            if (/window\.scrollBy\(/.test(expr)) {
              cb({ result: { type: "undefined" } });
              return;
            }
            // Default evaluate returns undefined
            cb({ result: { type: "undefined" } });
            return;
          }
          cb({});
        },
        onEvent: {
          addListener: (_fn: any) => {},
          removeListener: (_fn: any) => {},
        },
        onDetach: {
          addListener: (_fn: any) => {},
          removeListener: (_fn: any) => {},
        },
      },
    };
  });

  it("attaches and detaches", async () => {
    const r = new CDPReplayer({ tabId: 123 });
    await r.attach();
    expect(attachCount).toBe(1);
    // enableDomains should have been called
    const enabled = sendCalls.filter((c) => /^(Page|DOM|Runtime|Network)\.enable$/.test(c.method)).length;
    expect(enabled).toBe(4);
    await r.detach();
    expect(detachCount).toBe(1);
  });

  it("navigates and waits for DOM ready", async () => {
    const r = new CDPReplayer({ tabId: 1 });
    await r.attach();
    // Force eval("document.readyState") to resolve to complete (default mock)
    const step: ActionStep = {
      kind: "action",
      action: { name: "navigate", url: "https://example.com" },
      selector: { selector: "body", strategy: "css", shadowChain: [], frameChain: [] },
      timestamp: Date.now(),
    };
    await r.applyAction(step);
    const nav = sendCalls.find((c) => c.method === "Page.navigate");
    expect(nav).toBeTruthy();
    expect(nav?.params?.url).toBe("https://example.com");
  });

  it("clicks and double-clicks resolved center", async () => {
    const r = new CDPReplayer({ tabId: 1 });
    await r.attach();
    vi.spyOn(r as any, "eval").mockResolvedValue({ x: 100, y: 200 });

    const base = {
      kind: "action" as const,
      selector: { selector: "#btn", strategy: "css", shadowChain: [], frameChain: [] },
      timestamp: Date.now(),
    };

    await r.applyAction({ ...base, action: { name: "click" } });
    let mouseCalls = sendCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
    // mouseMoved + pressed + released
    expect(mouseCalls.length).toBe(3);
    expect(mouseCalls[1].params.clickCount).toBe(1);
    expect(mouseCalls[2].params.clickCount).toBe(1);

    sendCalls.length = 0;
    await r.applyAction({ ...base, action: { name: "dblclick" } });
    mouseCalls = sendCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
    // mouseMoved + 2*(pressed+released)
    expect(mouseCalls.length).toBe(5);
    expect(mouseCalls[1].params.clickCount).toBe(1);
    expect(mouseCalls[2].params.clickCount).toBe(1);
    expect(mouseCalls[3].params.clickCount).toBe(2);
    expect(mouseCalls[4].params.clickCount).toBe(2);
  });

  it("types text when not redacted and skips when redacted", async () => {
    const r = new CDPReplayer({ tabId: 1 });
    await r.attach();
    vi.spyOn(r as any, "eval").mockResolvedValue({ x: 10, y: 20 });

    const base: Omit<ActionStep, "action"> = {
      kind: "action",
      selector: { selector: "input", strategy: "css", shadowChain: [], frameChain: [] },
      timestamp: Date.now(),
    };

    sendCalls.length = 0;
    await r.applyAction({ ...base, action: { name: "type", text: "hello" }, redacted: false });
    const insertTextCalls = sendCalls.filter((c) => c.method === "Input.insertText");
    expect(insertTextCalls.length).toBe(1);
    expect(insertTextCalls[0].params.text).toBe("hello");

    sendCalls.length = 0;
    await r.applyAction({ ...base, action: { name: "type", text: "secret" }, redacted: true });
    expect(sendCalls.find((c) => c.method === "Input.insertText")).toBeFalsy();
  });

  it("presses Enter as keyDown/keyUp", async () => {
    const r = new CDPReplayer({ tabId: 1 });
    await r.attach();
    const step: ActionStep = {
      kind: "action",
      action: { name: "press", key: "Enter" },
      selector: { selector: "body", strategy: "css", shadowChain: [], frameChain: [] },
      timestamp: Date.now(),
    };
    await r.applyAction(step);
    const keyCalls = sendCalls.filter((c) => c.method === "Input.dispatchKeyEvent");
    expect(keyCalls.length).toBe(2);
    expect(keyCalls[0].params.type).toBe("keyDown");
    expect(keyCalls[1].params.type).toBe("keyUp");
  });

  it("scrolls the window via Runtime.evaluate", async () => {
    const r = new CDPReplayer({ tabId: 1 });
    await r.attach();
    const step: ActionStep = {
      kind: "action",
      action: { name: "scroll", deltaX: 10, deltaY: 20 },
      selector: { selector: "body", strategy: "css", shadowChain: [], frameChain: [] },
      timestamp: Date.now(),
    };
    await r.applyAction(step);
    const evalCall = sendCalls.find((c) => c.method === "Runtime.evaluate" && /window\.scrollBy\(10, 20\)/.test(String(c.params?.expression)));
    expect(evalCall).toBeTruthy();
  });

  it("hovers by moving the mouse to element center", async () => {
    const r = new CDPReplayer({ tabId: 1 });
    await r.attach();
    vi.spyOn(r as any, "eval").mockResolvedValue({ x: 50, y: 60 });

    const step: ActionStep = {
      kind: "action",
      action: { name: "hover" },
      selector: { selector: "#menuitem", strategy: "css", shadowChain: [], frameChain: [] },
      timestamp: Date.now(),
    };
    await r.applyAction(step);
    const moves = sendCalls.filter((c) => c.method === "Input.dispatchMouseEvent" && c.params?.type === "mouseMoved");
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(moves[0].params.x).toBe(50);
    expect(moves[0].params.y).toBe(60);
  });

  it("drags from start to end and releases", async () => {
    const r = new CDPReplayer({ tabId: 1 });
    await r.attach();
    // First center for start, then for end
    const evalSpy = vi.spyOn(r as any, "eval");
    evalSpy.mockResolvedValueOnce({ x: 10, y: 20 });
    evalSpy.mockResolvedValueOnce({ x: 110, y: 120 });

    const step: ActionStep = {
      kind: "action",
      action: { name: "drag", toSelector: { selector: "#end", strategy: "css", shadowChain: [], frameChain: [] } },
      selector: { selector: "#start", strategy: "css", shadowChain: [], frameChain: [] },
      timestamp: Date.now(),
    };
    await r.applyAction(step);
    const events = sendCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
    const pressed = events.find((e) => e.params?.type === "mousePressed");
    const released = events.find((e) => e.params?.type === "mouseReleased");
    expect(pressed).toBeTruthy();
    expect(released).toBeTruthy();
  });

  it("highlights by simulating a drag selection", async () => {
    const r = new CDPReplayer({ tabId: 1 });
    await r.attach();
    const evalSpy = vi.spyOn(r as any, "eval");
    evalSpy.mockResolvedValueOnce({ x: 5, y: 6 });
    evalSpy.mockResolvedValueOnce({ x: 105, y: 106 });

    const step: ActionStep = {
      kind: "action",
      action: { name: "highlight", toSelector: { selector: "#end", strategy: "css", shadowChain: [], frameChain: [] }, text: "hello" },
      selector: { selector: "#start", strategy: "css", shadowChain: [], frameChain: [] },
      timestamp: Date.now(),
    };
    await r.applyAction(step);
    const events = sendCalls.filter((c) => c.method === "Input.dispatchMouseEvent");
    const pressed = events.find((e) => e.params?.type === "mousePressed");
    const released = events.find((e) => e.params?.type === "mouseReleased");
    expect(pressed).toBeTruthy();
    expect(released).toBeTruthy();
  });

  it("play() sleeps based on timestamp deltas (capped) and applies actions in order", async () => {
    const r = new CDPReplayer({ tabId: 1 });
    await r.attach();
    const sleepSpy = vi.spyOn(r as any, "sleep").mockResolvedValue();
    const applySpy = vi.spyOn(r as any, "applyAction");

    const now = Date.now();
    const trace: TracePayload = {
      meta: { version: 1 },
      steps: [
        { kind: "action", action: { name: "press", key: "Enter" }, selector: { selector: "body", strategy: "css", shadowChain: [], frameChain: [] }, timestamp: now },
        { kind: "action", action: { name: "press", key: "Enter" }, selector: { selector: "body", strategy: "css", shadowChain: [], frameChain: [] }, timestamp: now + 2000 },
      ],
    };

    await r.play(trace, 1);
    // First step does not sleep; second should sleep min(1500, 2000)
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).toHaveBeenCalledWith(1500);
    expect(applySpy).toHaveBeenCalledTimes(2);
    expect((applySpy.mock.calls[0][0] as ActionStep).action.name).toBe("press");
    expect((applySpy.mock.calls[1][0] as ActionStep).action.name).toBe("press");
  });
});


