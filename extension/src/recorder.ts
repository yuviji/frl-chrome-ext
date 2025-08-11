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
  private hoverBuffer: { el: Element; lastTs: number } | null = null;
  private hoverFlushTimer: number | undefined;
  private dragState: { startEl: Element; startX: number; startY: number; active: boolean } | null = null;
  private initializedHistoryPatch = false;
  private startUrl: string | null = null;

  start() {
    if (this.isRecording) return;
    this.isRecording = true;
    this.steps = [];
    this.startUrl = location.href;
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
      startUrl: this.startUrl ?? undefined,
    };
    return { meta, steps: this.steps.slice() };
  }

  private installListeners() {
    window.addEventListener("click", this.onClick, true);
    window.addEventListener("dblclick", this.onDblClick, true);
    window.addEventListener("keydown", this.onKeydown, true);
    window.addEventListener("input", this.onInput as EventListener, true);
    window.addEventListener("wheel", this.onWheel, { capture: true, passive: true } as any);
    window.addEventListener("mousemove", this.onMouseMove, { capture: true, passive: true } as any);
    window.addEventListener("mousedown", this.onMouseDown, true);
    window.addEventListener("mouseup", this.onMouseUp, true);
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
    window.removeEventListener("mousemove", this.onMouseMove as EventListener, true);
    window.removeEventListener("mousedown", this.onMouseDown as EventListener, true);
    window.removeEventListener("mouseup", this.onMouseUp as EventListener, true);
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
    this.logInteraction("click", target);
    const selector = buildSelector(target);
    const step: ActionStep = {
      kind: "action",
      action: { name: "click" },
      selector,
      timestamp: Date.now(),
    };
    this.pushStep(step);
    this.awaitAndRecordPredicate(target).catch(() => {});
  };

  getRecentSteps(limit: number = 5): TracePayload["steps"] {
    if (limit <= 0) return [];
    const start = Math.max(0, this.steps.length - limit);
    return this.steps.slice(start);
  }

  private onDblClick = (ev: MouseEvent) => {
    if (!this.isRecording) return;
    const target = this.getEventTargetElement(ev);
    if (!target) return;
    this.logInteraction("dblclick", target);
    const selector = buildSelector(target);
    const step: ActionStep = {
      kind: "action",
      action: { name: "dblclick" },
      selector,
      timestamp: Date.now(),
    };
    this.pushStep(step);
    this.awaitAndRecordPredicate(target).catch(() => {});
  };

  private onKeydown = (ev: KeyboardEvent) => {
    if (!this.isRecording) return;
    const target = (ev.target as Element) || null;
    if (!target || !(target instanceof Element)) return;
    if (ev.key === "Enter") {
      this.logInteraction("press:Enter", target);
      const selector = buildSelector(target);
      const step: ActionStep = {
        kind: "action",
        action: { name: "press", key: "Enter" },
        selector,
        timestamp: Date.now(),
      };
      this.pushStep(step);
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

    // Redaction for sensitive inputs
    const { isSensitive } = this.detectSensitivity(target);
    const recordedText = isSensitive ? "***" : text;
    this.logInteraction("type", target, recordedText);
    const selector = buildSelector(target);
    const step: ActionStep = {
      kind: "action",
      action: { name: "type", text: recordedText },
      selector,
      timestamp: Date.now(),
      redacted: isSensitive || undefined,
    };
    this.pushStep(step);
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

  private onMouseMove = (ev: MouseEvent) => {
    if (!this.isRecording) return;
    const target = this.getEventTargetElement(ev);
    if (!target) return;
    // Track drag selection path as highlight
    if (this.dragState && this.dragState.active) {
      // We do not emit on every move; the final mouseup will generate a highlight step
    }
    const el = target;
    const now = Date.now();
    // Only record hovers over menu/listbox/menuitem/option-ish targets to avoid noise
    if (!this.isMenuish(el)) return;
    // Throttle to avoid floods
    if (this.hoverBuffer && this.hoverBuffer.el === el && now - this.hoverBuffer.lastTs < 150) {
      this.hoverBuffer.lastTs = now;
      return;
    }
    this.hoverBuffer = { el, lastTs: now };
    if (this.hoverFlushTimer) clearTimeout(this.hoverFlushTimer);
    this.hoverFlushTimer = setTimeout(() => this.flushHoverBuffer(), 120) as unknown as number;
  };

  private isMenuish(el: Element): boolean {
    const role = (el.getAttribute("role") || "").toLowerCase();
    const tag = el.tagName.toLowerCase();
    if (role.includes("menuitem") || role.includes("option") || role === "menu" || role === "listbox") return true;
    if (tag === "option" || tag === "li") return true;
    if (el.closest('[role="menu"], [role="listbox"], ul[role], ol[role]')) return true;
    return false;
  }

  private flushHoverBuffer() {
    if (!this.hoverBuffer) return;
    const { el } = this.hoverBuffer;
    this.hoverBuffer = null;
    const selector = buildSelector(el);
    const step: ActionStep = {
      kind: "action",
      action: { name: "hover" },
      selector,
      timestamp: Date.now(),
    };
    this.pushStep(step);
    // If this hover is over a menu trigger or menu item, record a follow-up wait to capture submenu reveal
    try {
      const hasPopup = (el.getAttribute("aria-haspopup") || "").toLowerCase().includes("menu");
      if (hasPopup || this.isMenuish(el)) {
        this.awaitAndRecordPredicate(el).catch(() => {});
      }
    } catch {}
  }

  private onMouseDown = (ev: MouseEvent) => {
    if (!this.isRecording) return;
    const target = this.getEventTargetElement(ev);
    if (!target) return;
    this.dragState = { startEl: target, startX: ev.clientX, startY: ev.clientY, active: true };
  };

  private onMouseUp = (ev: MouseEvent) => {
    if (!this.isRecording) return;
    if (!this.dragState || !this.dragState.active) return;
    this.dragState.active = false;
    const start = this.dragState;
    const endTarget = this.getEventTargetElement(ev) || document.elementFromPoint(ev.clientX, ev.clientY) || start.startEl;
    const endEl = endTarget as Element;
    const isSelection = this.hasUserSelection();
    if (isSelection) {
      const startSel = buildSelector(start.startEl);
      const endSel = buildSelector(endEl);
      const step: ActionStep = {
        kind: "action",
        action: { name: "highlight", toSelector: endSel, toX: ev.clientX, toY: ev.clientY, text: this.getSelectedTextSafe() },
        selector: startSel,
        timestamp: Date.now(),
      };
      this.pushStep(step);
      // selection usually implies text change/layout; record wait
      this.awaitAndRecordPredicate(endEl).catch(() => {});
    } else {
      // Treat as drag
      const startSel = buildSelector(start.startEl);
      const endSel = buildSelector(endEl);
      const step: ActionStep = {
        kind: "action",
        action: { name: "drag", toSelector: endSel, toX: ev.clientX, toY: ev.clientY },
        selector: startSel,
        timestamp: Date.now(),
      };
      this.pushStep(step);
      this.awaitAndRecordPredicate(endEl).catch(() => {});
    }
  };

  private hasUserSelection(): boolean {
    try {
      const sel = window.getSelection();
      return !!sel && !sel.isCollapsed && String(sel.toString()).trim().length > 0;
    } catch {
      return false;
    }
  }

  private getSelectedTextSafe(): string | undefined {
    try {
      const t = String(window.getSelection()?.toString() || "").trim();
      return t || undefined;
    } catch {
      return undefined;
    }
  }

  private flushScrollBuffer() {
    if (!this.scrollBuffer) return;
    const { el, dx, dy } = this.scrollBuffer;
    this.scrollBuffer = null;
    this.logInteraction("scroll", el, `${Math.trunc(dx)},${Math.trunc(dy)}`);
    const selector = buildSelector(el);
    const step: ActionStep = {
      kind: "action",
      action: { name: "scroll", deltaX: dx, deltaY: dy },
      selector,
      timestamp: Date.now(),
    };
    this.pushStep(step);
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
    this.pushStep(step);
    this.awaitAndRecordPredicate(rootEl).catch(() => {});
  };

  private getEventTargetElement(ev: Event): Element | null {
    const path = (ev as any).composedPath ? (ev as any).composedPath() : [];
    const target = (path[0] as Element) || (ev.target as Element | null);
    if (!target || !(target instanceof Element)) return null;
    return this.normalizeTargetElement(target);
  }

  private normalizeTargetElement(el: Element): Element {
    // If target is inside SVG, prefer the nearest non-SVG accessible ancestor
    const isSvg = (node: Element | null) => !!node && (node instanceof (globalThis as any).SVGElement || String(node.namespaceURI || '').toLowerCase().includes('svg'));
    const isInteractiveTag = (node: Element) => {
      const tag = node.tagName.toLowerCase();
      if (tag === 'button' || tag === 'a' || tag === 'input' || tag === 'textarea' || tag === 'select' || tag === 'summary' || tag === 'label') return true;
      const role = (node.getAttribute('role') || '').toLowerCase();
      if (role && role !== 'presentation' && role !== 'none') return true;
      const tabIndexAttr = node.getAttribute('tabindex');
      const tabIndex = tabIndexAttr != null ? parseInt(tabIndexAttr, 10) : NaN;
      const contentEditable = (node as HTMLElement).isContentEditable === true;
      return contentEditable || (Number.isFinite(tabIndex) && tabIndex >= 0);
    };
    // First, lift out of any SVG subtree to closest non-SVG element
    let node: Element | null = el;
    while (node && isSvg(node)) {
      node = node.parentElement;
    }
    if (!node) return el;
    // Then climb to nearest accessible ancestor if available
    let cur: Element | null = node;
    while (cur && cur !== document.body) {
      if (isInteractiveTag(cur) || cur.hasAttribute('data-testid') || cur.hasAttribute('data-test') || cur.hasAttribute('data-qa') || cur.id) {
        return cur;
      }
      cur = cur.parentElement;
    }
    return node;
  }

  private logInteraction(kind: string, el: Element, note?: string) {
    try {
      const snap = this.elementSnapshot(el);
      // eslint-disable-next-line no-console
      console.log("[FRL][record]", { kind, note, element: snap });
    } catch {}
  }

  private elementSnapshot(el: Element): string {
    try {
      const outer = (el as HTMLElement).outerHTML || "";
      if (outer) return outer.length > 800 ? outer.slice(0, 800) + "…" : outer;
    } catch {}
    try {
      const tag = el.tagName.toLowerCase();
      const id = (el as HTMLElement).id ? `#${(el as HTMLElement).id}` : "";
      const cls = (el as HTMLElement).className ? `.${String((el as HTMLElement).className).trim().split(/\s+/).join('.')}` : "";
      const role = el.getAttribute("role");
      const aria = el.getAttribute("aria-label");
      const testid = el.getAttribute("data-testid");
      return `<${tag}${id}${cls}${role ? ` role=\"${role}\"` : ""}${aria ? ` aria-label=\"${aria}\"` : ""}${testid ? ` data-testid=\"${testid}\"` : ""}>`;
    } catch {}
    return String(el);
  }

  private detectSensitivity(target: Element): { isSensitive: boolean } {
    // Sensitive if input type=password or if associated label hints at sensitivity
    if (target instanceof HTMLInputElement) {
      const type = (target.getAttribute("type") || "text").toLowerCase();
      if (type === "password") return { isSensitive: true };
    }
    const maybeLabelText = this.findAssociatedLabelText(target)?.toLowerCase() || "";
    if (maybeLabelText && /password|passcode|otp|one[-\s]?time|secret|api\s*key|token/i.test(maybeLabelText)) {
      return { isSensitive: true };
    }
    // Also check aria-label/title placeholders
    const aria = (target.getAttribute("aria-label") || target.getAttribute("title") || (target as HTMLInputElement).placeholder || "").toLowerCase();
    if (aria && /password|passcode|otp|one[-\s]?time|secret|api\s*key|token/i.test(aria)) {
      return { isSensitive: true };
    }
    return { isSensitive: false };
  }

  private findAssociatedLabelText(target: Element): string | null {
    // Explicit label by for= id
    const id = (target as HTMLElement).id;
    if (id) {
      const lbl = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lbl) return (lbl.textContent || "").trim();
    }
    // Implicit label: closest <label> ancestor
    const implicit = target.closest("label");
    if (implicit) return (implicit.textContent || "").trim();
    return null;
  }

  private detectContainer(el: Element): Element {
    // Prefer meaningful ancestor: skip sentinel/presentation wrappers; choose role/id/data-* anchors; else body
    let node: Element | null = el;
    while (node && node !== document.body) {
      // Skip roles that don't convey structure/content containers
      const role = (node.getAttribute("role") || "").toLowerCase();
      if (role === "presentation" || role === "none") {
        node = node.parentElement;
        continue;
      }
      // Skip decorative/layout-only wrappers commonly seen
      const id = node.id || "";
      const cls = node.className || "";
      if (/^overlay-|^modal-backdrop|^tooltip-|^toast-/.test(id) || /\b(sentinel|backdrop|overlay|tooltip|toast)\b/i.test(String(cls))) {
        node = node.parentElement;
        continue;
      }
      if (node.hasAttribute("role") || id || node.hasAttribute("data-testid") || node.hasAttribute("data-test") || node.hasAttribute("data-qa")) {
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
      // Title changes indicate activity, but should NOT imply urlChanged
      // unless the actual location.href changed relative to the baseline.
      markActivity();
      if (document.title !== baselineTitle && location.href !== baselineUrl) {
        flags.urlChanged = true;
      }
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
    this.pushStep(predStep);

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

  private pushStep(step: ActionStep | WaitPredicateStep) {
    // Default logical tab id stamping
    if (typeof (step as any).tabLid === "undefined") {
      (step as any).tabLid = 1;
    }
    this.steps.push(step);
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



