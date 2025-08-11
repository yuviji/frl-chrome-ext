import type { BuiltSelector, SelectorStrategy } from "./types";

// Utilities
const DATA_TEST_ATTRS = ["data-testid", "data-test", "data-qa"] as const;

export function textHintFor(node: Element | null): string | undefined {
  if (!node) return undefined;
  // Prefer aria-label/name-like attributes or visible text
  const label = (node.getAttribute("aria-label") || node.getAttribute("aria-labelledby"))?.trim();
  if (label) return truncate(label);
  const text = (node.textContent || "").trim().replace(/\s+/g, " ");
  if (text) return truncate(text);
  return undefined;
}

export function roleHintFor(node: Element | null): string | undefined {
  if (!node) return undefined;
  const role = node.getAttribute("role")?.trim();
  if (role) return role;
  // Map some common tags to implied roles
  const tag = node.tagName.toLowerCase();
  switch (tag) {
    case "button":
      return "button";
    case "a":
      return node.hasAttribute("href") ? "link" : undefined;
    case "input": {
      const type = (node.getAttribute("type") || "text").toLowerCase();
      if (type === "checkbox") return "checkbox";
      if (type === "radio") return "radio";
      if (type === "submit" || type === "button") return "button";
      return "textbox";
    }
    case "select":
      return "combobox";
    case "textarea":
      return "textbox";
  }
  return undefined;
}

export function buildSelector(target: Element): BuiltSelector {
  const { shadowChain, deepestRoot } = buildShadowChain(target);
  const { frameChain } = buildFrameChain(deepestRoot);

  // Try ARIA role+name first
  const aria = buildAriaSelector(target);
  if (aria) {
    const built = finalize(aria, "aria", shadowChain, frameChain, target);
    built.nameMatch = "exact";
    const ariaContains = buildAriaSelectorContains(target);
    if (ariaContains) {
      built.alternatives = built.alternatives ?? [];
      built.alternatives.push({ strategy: "aria", selector: ariaContains, nameMatch: "contains" });
    }
    return built;
  }

  // Then data-* test attributes
  const dataSel = buildDataAttrSelector(target);
  if (dataSel) {
    return finalize(dataSel, "data", shadowChain, frameChain, target);
  }

  // Final fallback to compact CSS with nth-of-type
  const css = buildCompactCssSelector(target, deepestRoot);
  return finalize(css, "css", shadowChain, frameChain, target);
}

function finalize(selector: string, strategy: SelectorStrategy, shadowChain: string[], frameChain: string[], target: Element): BuiltSelector {
  return {
    selector,
    strategy,
    shadowChain,
    frameChain,
    textHint: textHintFor(target),
    roleHint: roleHintFor(target),
  };
}

const DISALLOWED_ARIA_ROLES = new Set(["presentation", "none"]);
const PREFERRED_ARIA_ROLES = new Set([
  "button",
  "link",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "option",
  "tab",
  "textbox",
  "combobox",
  "slider",
  "heading",
]);

function buildAriaSelector(el: Element): string | null {
  // Prefer WAI-ARIA: role + accessible name approximation
  const role = roleHintFor(el);
  const nameInfo = accessibleNameWithSource(el);
  const name = nameInfo?.name;
  const source = nameInfo?.source;
  if (!role || !name) return null;
  if (DISALLOWED_ARIA_ROLES.has(role)) return null;
  // If role is not explicitly preferred, still allow but be stricter on text-based names
  const isPreferredRole = PREFERRED_ARIA_ROLES.has(role);
  const maxLen = isPreferredRole ? 80 : 60;
  // Avoid huge names or names derived from massive text content
  if (name.length > maxLen) return null;
  if (source === "text" && name.length > 60) return null;
  // We use a pseudo selector syntax: role=<role> name=<name>
  // Consumers can translate to their selector engine (e.g., Playwright getByRole)
  return `role=${cssEsc(role)}\x20name=${cssEsc(name)}`;
}

function buildAriaSelectorContains(el: Element): string | null {
  const role = roleHintFor(el);
  const info = accessibleNameWithSource(el);
  const name = info?.name;
  const source = info?.source;
  if (!role || !name) return null;
  if (DISALLOWED_ARIA_ROLES.has(role)) return null;
  // Apply same constraints as exact
  const isPreferredRole = PREFERRED_ARIA_ROLES.has(role);
  const maxLen = isPreferredRole ? 80 : 60;
  if (name.length > maxLen) return null;
  if (source === "text" && name.length > 60) return null;
    // contains/substring match marker ~=
    return `role=${cssEsc(role)}\x20name~=${cssEsc(name)}`;
  return null;
}

function buildDataAttrSelector(el: Element): string | null {
  for (const attr of DATA_TEST_ATTRS) {
    const val = el.getAttribute(attr);
    if (val) {
      return `[${attr}="${cssEsc(val)}"]`;
    }
  }
  return null;
}

function buildCompactCssSelector(el: Element, root: Document | ShadowRoot): string {
  // Walk up building a compact chain. If we encounter a stable id anchor, stop climbing there.
  const parts: string[] = [];
  let node: Element | null = el;
  const stopAt = root instanceof Document ? root.documentElement : root.host;
  let hitAnchor = false;

  while (node && node !== stopAt) {
    const part = cssPart(node);
    parts.unshift(part);
    // If this part is an id anchor, we can stop. '#id' is globally unique enough.
    if (part.startsWith("#")) {
      hitAnchor = true;
      break;
    }
    node = node.parentElement;
  }

  // Only include the top element when we didn't already stop at an anchor
  if (!hitAnchor && stopAt && stopAt !== (root instanceof Document ? root.documentElement : null)) {
    parts.unshift(cssPart(stopAt));
  }
  return parts.join(" > ");
}

// (XPath generation removed)

function cssPart(node: Element): string {
  // If element has a stable-looking id, prefer #id
  const id = node.getAttribute("id");
  if (id && isIdStable(id)) return `#${cssEsc(id)}`;

  // Prefer class if single, short, and unique among siblings of same tag
  const className = pickStableClass(node);
  const tag = node.tagName.toLowerCase();

  if (className) {
    return `${tag}.${className}`;
  }

  // Try a stable attribute-based selector before nth-of-type
  const stableAttr = buildStableAttributeSelector(node);
  if (stableAttr) return stableAttr;

  // Fallback to nth-of-type for compactness
  const index = nthOfTypeIndex(node);
  return `${tag}:nth-of-type(${index})`;
}

function nthOfTypeIndex(node: Element): number {
  const tag = node.tagName;
  let i = 0;
  let sib: Element | null = node.parentElement?.firstElementChild as Element | null;
  while (sib) {
    if (sib.tagName === tag) i++;
    if (sib === node) return i;
    sib = sib.nextElementSibling as Element | null;
  }
  return 1;
}

function pickStableClass(node: Element): string | null {
  const classList = Array.from(node.classList);
  if (classList.length !== 1) return null;
  const cls = classList[0];
  // Avoid dynamic looking classes
  if (/\d/.test(cls) || cls.length > 30) return null;
  // Check uniqueness among same-tag siblings
  const tag = node.tagName.toLowerCase();
  const siblings = node.parentElement?.querySelectorAll(`${tag}.${cssEsc(cls)}`) ?? [];
  if (siblings.length === 1) return cssEsc(cls);
  return null;
}

function isIdStable(id: string): boolean {
  if (typeof id !== 'string') return false;
  const trimmed = id.trim();
  if (!trimmed) return false;
  if (trimmed.length > 40) return false;
  // Allow only alphanumerics, dash and underscore
  if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(trimmed)) return false;
  // Reject if contains long digit or hex-like runs (e.g., 3+ in a row)
  if (/(?:[0-9]{3,}|[A-Fa-f0-9]{5,})/.test(trimmed)) return false;
  // Reject if looks like multiple random-ish segments joined by -/_ (e.g., foo-1a2b3c-9d8e7f)
  if (/(?:^|[-_])[A-Za-z0-9]{4,}(?:[-_][A-Za-z0-9]{4,}){2,}$/.test(trimmed)) return false;
  // Digit density heuristic: if more than ~35% digits, likely unstable
  const digitCount = (trimmed.match(/[0-9]/g) || []).length;
  if (digitCount / trimmed.length > 0.35) return false;
  return true;
}

function buildStableAttributeSelector(node: Element): string | null {
  const tag = node.tagName.toLowerCase();
  const parts: string[] = [tag];
  const add = (attr: string) => {
    const raw = node.getAttribute(attr);
    if (!raw) return;
    const val = raw.trim();
    if (!val) return;
    // Avoid dynamic-looking values
    if (val.length > 40) return;
    if (/(?:[0-9]{3,}|[A-Fa-f0-9]{5,})/.test(val)) return;
    if (/[«»]/.test(val)) return;
    parts.push(`[${attr}="${cssEsc(val)}"]`);
  };

  // Prefer stable attributes; avoid stateful ones like aria-expanded/data-state
  add('data-testid');
  add('data-test');
  add('data-qa');
  add('type');
  add('aria-label');
  add('aria-haspopup');
  // If role attribute present and short, include it
  add('role');

  // If only tag with no attributes, return null
  if (parts.length <= 1) return null;
  return parts.join('');
}

function cssEsc(value: string): string {
  // Basic escape for quotes and backslashes
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function truncate(text: string, max = 120): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function buildShadowChain(el: Element): { shadowChain: string[]; deepestRoot: Document | ShadowRoot } {
  const chain: string[] = [];
  let node: Node | null = el;
  let currentRoot: Document | ShadowRoot = el.getRootNode() as Document | ShadowRoot;

  // Walk outwards through shadow roots collecting host selectors
  while (currentRoot instanceof ShadowRoot) {
    const host = currentRoot.host;
    chain.unshift(buildCompactCssSelector(host, host.getRootNode() as Document | ShadowRoot));
    currentRoot = host.getRootNode() as Document | ShadowRoot;
  }

  return { shadowChain: chain, deepestRoot: el.getRootNode() as Document | ShadowRoot };
}

function buildFrameChain(root: Document | ShadowRoot): { frameChain: string[] } {
  const chain: string[] = [];
  // Only documents live inside frames. ShadowRoot implies same document.
  if (root instanceof Document) {
    let win: Window | null = root.defaultView;
    while (win && win !== win.top) {
      const frameEl = win.frameElement as Element | null;
      if (!frameEl) break;
      const frameHostRoot = frameEl.getRootNode() as Document | ShadowRoot;
      chain.unshift(buildCompactCssSelector(frameEl, frameHostRoot));
      win = frameEl.ownerDocument?.defaultView?.parent ?? null;
    }
  }
  return { frameChain: chain };
}

// Lightweight accessible name approximation with source
function accessibleNameWithSource(el: Element): { name: string; source: "aria-label" | "alt" | "title" | "text" } | null {
  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel && ariaLabel.trim()) return { name: ariaLabel.trim(), source: "aria-label" };
  const ariaLabelledBy = el.getAttribute("aria-labelledby");
  if (ariaLabelledBy && ariaLabelledBy.trim()) {
    // Simplify: treat as aria-label if present
    return { name: ariaLabelledBy.trim(), source: "aria-label" };
  }
  const alt = (el as HTMLImageElement).alt;
  if (typeof alt === "string" && alt.trim()) return { name: alt.trim(), source: "alt" };
  const title = el.getAttribute("title");
  if (title && title.trim()) return { name: title.trim(), source: "title" };
  const text = (el.textContent || "").trim().replace(/\s+/g, " ");
  if (text) return { name: text, source: "text" };
  return null;
}

export {};


