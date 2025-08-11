import { buildSelector, roleHintFor, textHintFor } from "./selector";
import type {
  ActionKind,
  ActionStep,
  BuiltSelector,
  PredicateName,
  TracePayload,
  WaitPredicateStep,
} from "./types";

type PredicateFlags = {
  urlChanged: boolean;
  domAdded: boolean;
  ariaLiveUpdated: boolean;
  textChanged: boolean;
  layoutStable: boolean;
};

const PREDICATE_PRIORITY: PredicateName[] = [
  "urlChanged",
  "domAdded",
  "ariaLiveUpdated",
  "textChanged",
  "layoutStable",
];

export class Recorder {
  private isRecording = false;
  private steps: TracePayload["steps"] = [];
  private lastActivityTs = Date.now();
  private scrollBuffer: { el: Element; dx: number; dy: number } | null = null;
  private scrollFlushTimer: number | undefined;
  private initializedHistoryPatch = false;

  start() {
    if (this.isRecording) return;
    this.isRecording = true;
    this.steps = [];
    this.installListeners();
  }

  stop() {
    this.isRecording = false;
    this.removeListeners();
    this.flushScrollBuffer();
  }

  dump(): TracePayload {
    const meta: TracePayload["meta"] = {
      version: 1,
      recorder: "frl-ext",
      startedAt: new Date().toISOString(),
      userAgent: navigator.userAgent,
      viewport: { width: window.innerWidth, height: window.innerHeight },
    };
    return { meta, steps: this.steps.slice() };
  }

  private installListeners() {
    window.addEventListener("click", this.onClick, true);
    window.addEventListener("dblclick", this.onDblClick, true);
    window.addEventListener("keydown", this.onKeydown, true);
    window.addEventListener("input", this.onInput as EventListener, true);
    window.addEventListener("wheel", this.onWheel, { capture: true, passive: true } as any);
    window.addEventListener("scroll", this.onAnyActivity, true);
    window.addEventListener("resize", this.onAnyActivity, true);
    this.patchHistory();
    window.addEventListener("popstate", this.onLocationChange, true);
    window.addEventListener("hashchange", this.onLocationChange, true);
    window.addEventListener("frl:locationchange", this.onLocationChange as EventListener, true);
  }

  private removeListeners() {
    window.removeEventListener("click", this.onClick, true);
    window.removeEventListener("dblclick", this.onDblClick, true);
    window.removeEventListener("keydown", this.onKeydown, true);
    window.removeEventListener("input", this.onInput as EventListener, true);
    window.removeEventListener("wheel", this.onWheel as EventListener, true);
    window.removeEventListener("scroll", this.onAnyActivity, true);
    window.removeEventListener("resize", this.onAnyActivity, true);
    window.removeEventListener("popstate", this.onLocationChange, true);
    window.removeEventListener("hashchange", this.onLocationChange, true);
    window.removeEventListener("frl:locationchange", this.onLocationChange as EventListener, true);
  }

  private onAnyActivity = () => {
    this.lastActivityTs = Date.now();
  };

  private onClick = (ev: MouseEvent) => {
    if (!this.isRecording) return;
    const target = this.getEventTargetElement(ev);
    if (!target) return;
    const selector = buildSelector(target);
    const step: ActionStep = {
      kind: "action",
      action: { name: "click" },
      selector,
      timestamp: Date.now(),
    };
    this.steps.push(step);
    this.awaitAndRecordPredicate(target).catch(() => {});
  };

  private onDblClick = (ev: MouseEvent) => {
    if (!this.isRecording) return;
    const target = this.getEventTargetElement(ev);
    if (!target) return;
    const selector = buildSelector(target);
    const step: ActionStep = {
      kind: "action",
      action: { name: "dblclick" },
      selector,
      timestamp: Date.now(),
    };
    this.steps.push(step);
    this.awaitAndRecordPredicate(target).catch(() => {});
  };

  private onKeydown = (ev: KeyboardEvent) => {
    if (!this.isRecording) return;
    const target = (ev.target as Element) || null;
    if (!target || !(target instanceof Element)) return;
    if (ev.key === "Enter") {
      const selector = buildSelector(target);
      const step: ActionStep = {
        kind: "action",
        action: { name: "press", key: "Enter" },
        selector,
        timestamp: Date.now(),
      };
      this.steps.push(step);
      this.awaitAndRecordPredicate(target).catch(() => {});
    }
  };

  private onInput = (ev: InputEvent) => {
    if (!this.isRecording) return;
    const target = (ev.target as Element) || null;
    if (!target || !(target instanceof Element)) return;
    // Only record if text was inserted
    const text = (ev as InputEvent).data ?? "";
    if (!text) return;
    const selector = buildSelector(target);
    const step: ActionStep = {
      kind: "action",
      action: { name: "type", text },
      selector,
      timestamp: Date.now(),
    };
    this.steps.push(step);
    this.awaitAndRecordPredicate(target).catch(() => {});
  };

  private onWheel = (ev: WheelEvent) => {
    if (!this.isRecording) return;
    const target = this.getEventTargetElement(ev);
    const el = target ?? (document.scrollingElement as Element | null) ?? document.documentElement;
    // coalesce deltas per element within 100ms
    if (this.scrollBuffer && this.scrollBuffer.el === el) {
      this.scrollBuffer.dx += ev.deltaX;
      this.scrollBuffer.dy += ev.deltaY;
    } else {
      this.flushScrollBuffer();
      this.scrollBuffer = { el, dx: ev.deltaX, dy: ev.deltaY };
    }
    this.lastActivityTs = Date.now();
    if (this.scrollFlushTimer) clearTimeout(this.scrollFlushTimer);
    this.scrollFlushTimer = setTimeout(() => this.flushScrollBuffer(), 120) as unknown as number;
  };

  private flushScrollBuffer() {
    if (!this.scrollBuffer) return;
    const { el, dx, dy } = this.scrollBuffer;
    this.scrollBuffer = null;
    const selector = buildSelector(el);
    const step: ActionStep = {
      kind: "action",
      action: { name: "scroll", deltaX: dx, deltaY: dy },
      selector,
      timestamp: Date.now(),
    };
    this.steps.push(step);
    this.awaitAndRecordPredicate(el).catch(() => {});
  }

  private onLocationChange = () => {
    if (!this.isRecording) return;
    // Emit a navigate action when SPA route changes without click on <a>
    const rootEl = document.documentElement;
    const selector = buildSelector(rootEl);
    const step: ActionStep = {
      kind: "action",
      action: { name: "navigate", url: location.href, title: document.title },
      selector,
      timestamp: Date.now(),
    };
    this.steps.push(step);
    this.awaitAndRecordPredicate(rootEl).catch(() => {});
  };

  private getEventTargetElement(ev: Event): Element | null {
    const path = (ev as any).composedPath ? (ev as any).composedPath() : [];
    const target = (path[0] as Element) || (ev.target as Element | null);
    if (!target || !(target instanceof Element)) return null;
    return target;
  }

  private detectContainer(el: Element): Element {
    // Prefer meaningful ancestor: role/id/data-testid, else body
    let node: Element | null = el;
    while (node && node !== document.body) {
      if (node.hasAttribute("role") || node.id || node.hasAttribute("data-testid") || node.hasAttribute("data-test") || node.hasAttribute("data-qa")) {
        return node;
      }
      node = node.parentElement;
    }
    return document.body || el;
  }

  private async awaitAndRecordPredicate(target: Element): Promise<void> {
    const containerEl = this.detectContainer(target);
    const containerSel = buildSelector(containerEl);
    const baselineUrl = location.href;
    const baselineTitle = document.title;
    const baselineText = (containerEl.textContent || "").trim();
    const flags: PredicateFlags = {
      urlChanged: false,
      domAdded: false,
      ariaLiveUpdated: false,
      textChanged: false,
      layoutStable: false,
    };

    const markActivity = () => (this.lastActivityTs = Date.now());
    const updateLayoutStable = () => {
      const now = Date.now();
      flags.layoutStable = now - this.lastActivityTs >= 800;
    };
    this.lastActivityTs = Date.now();

    // Mutation observer scoped to container
    const mo = new MutationObserver((mutations) => {
      markActivity();
      for (const m of mutations) {
        if (m.type === "childList") {
          if (m.addedNodes && m.addedNodes.length > 0) {
            // Consider domAdded only when Element nodes are added, not text nodes
            const hasElement = Array.from(m.addedNodes).some((n) => n instanceof Element);
            if (hasElement) flags.domAdded = true;
          }
        }
        if (m.type === "characterData" || m.type === "childList" || m.type === "attributes") {
          // Check aria-live updated
          const nodes: Node[] = [];
          if (m.type === "characterData") nodes.push(m.target);
          if (m.type === "childList") nodes.push(...Array.from(m.addedNodes));
          if (m.target instanceof Element) nodes.push(m.target);
          if (nodes.some((n) => this.nodeInAriaLive(n))) flags.ariaLiveUpdated = true;
          const current = (containerEl.textContent || "").trim();
          if (current !== baselineText) flags.textChanged = true;
        }
      }
    });
    mo.observe(containerEl, { subtree: true, childList: true, characterData: true, attributes: true });

    // Title observer
    const titleEl = document.querySelector("head > title");
    const titleMo = new MutationObserver(() => {
      markActivity();
      if (document.title !== baselineTitle) flags.urlChanged = location.href !== baselineUrl || true; // prioritize title change as navigation-related
    });
    if (titleEl) titleMo.observe(titleEl, { childList: true, characterData: true, subtree: true });

    // URL change listeners
    let urlListener = () => {
      if (location.href !== baselineUrl) flags.urlChanged = true;
    };
    window.addEventListener("popstate", urlListener, { once: false, capture: true });
    window.addEventListener("hashchange", urlListener, { once: false, capture: true });
    window.addEventListener("frl:locationchange", urlListener as EventListener, { once: false, capture: true });

    // Wait loop up to 2000ms; update layoutStable continuously
    const start = Date.now();
    let chosen: PredicateName | null = null;
    while (Date.now() - start < 2000) {
      updateLayoutStable();
      const available = this.pickBestAvailable(flags);
      if (available) {
        chosen = available;
        // If best is urlChanged, resolve immediately; else allow a short grace to see if a higher priority arrives
        if (available === "urlChanged") break;
        // brief 100ms grace
        await this.sleep(100);
        const maybeBetter = this.pickBestAvailable(flags);
        chosen = maybeBetter ?? chosen;
        break;
      }
      await this.sleep(50);
    }
    // Fallback to layoutStable after 800ms idle if nothing selected
    if (!chosen) {
      // wait until idle >= 800ms or until 2s timeout
      while (Date.now() - start < 2000 && Date.now() - this.lastActivityTs < 800) {
        await this.sleep(50);
      }
      chosen = "layoutStable";
    }

    const predStep: WaitPredicateStep = {
      kind: "waitForPredicate",
      predicate: chosen,
      container: containerSel,
      timestamp: Date.now(),
    };
    this.steps.push(predStep);

    // cleanup
    mo.disconnect();
    titleMo.disconnect();
    window.removeEventListener("popstate", urlListener, true);
    window.removeEventListener("hashchange", urlListener, true);
    window.removeEventListener("frl:locationchange", urlListener as EventListener, true);
  }

  private nodeInAriaLive(n: Node): boolean {
    let el: Element | null = n instanceof Element ? n : n.parentElement;
    while (el) {
      const ariaLive = el.getAttribute("aria-live");
      if (ariaLive && ariaLive !== "off") return true;
      el = el.parentElement;
    }
    return false;
  }

  private pickBestAvailable(flags: PredicateFlags): PredicateName | null {
    for (const p of PREDICATE_PRIORITY) {
      if ((flags as any)[p]) return p;
    }
    return null;
  }

  private sleep(ms: number) {
    return new Promise<void>((r) => setTimeout(r, ms));
  }

  private patchHistory() {
    if (this.initializedHistoryPatch) return;
    this.initializedHistoryPatch = true;
    try {
      const fire = () => {
        const evt = new Event("frl:locationchange");
        window.dispatchEvent(evt);
      };
      const push = history.pushState;
      const replace = history.replaceState;
      history.pushState = ((orig) => {
        return function (...args: any[]) {
          const ret = orig.apply(history, args as any);
          fire();
          return ret;
        } as typeof history.pushState;
      })(push);
      history.replaceState = ((orig) => {
        return function (...args: any[]) {
          const ret = orig.apply(history, args as any);
          fire();
          return ret;
        } as typeof history.replaceState;
      })(replace);
    } catch {}
  }
}

export function createRecorder() {
  return new Recorder();
}



