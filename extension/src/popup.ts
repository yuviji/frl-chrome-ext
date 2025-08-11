function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

function setStatus(text: string) {
  const status = $("status");
  status.textContent = text;
}

async function sendToBackground(type: string) {
  return await chrome.runtime.sendMessage({ type });
}

async function fetchPreview(): Promise<any[] | null> {
  try {
    const res = await sendToBackground("FRL_POPUP_PREVIEW");
    if (!res?.ok) return null;
    return Array.isArray(res.data?.steps) ? res.data.steps : [];
  } catch {
    return null;
  }
}

function renderPreview(steps: any[]) {
  const ul = document.getElementById("recentSteps") as HTMLUListElement | null;
  if (!ul) return;
  ul.innerHTML = "";
  
  const truncate = (text: string, max = 80) => (text.length > max ? text.slice(0, max - 1) + "…" : text);
  const shortUrl = (u: string): string => {
    try {
      const url = new URL(u);
      const path = url.pathname === "/" ? "" : url.pathname;
      return `${url.hostname}${path}`;
    } catch {
      return u;
    }
  };
  const friendlyWait = (pred: string): string => {
    switch (pred) {
      case "urlChanged":
        return "wait for navigation";
      case "domAdded":
        return "wait for content to appear";
      case "ariaLiveUpdated":
        return "wait for announcement";
      case "textChanged":
        return "wait for text update";
      case "layoutStable":
        return "wait for page to settle";
      default:
        return `wait: ${pred}`;
    }
  };
  const pickNiceSelector = (sel: any): string => {
    const role = sel?.roleHint as string | undefined;
    const text = sel?.textHint as string | undefined;
    if (text && role) return `${role} “${truncate(text, 60)}”`;
    if (text) return `“${truncate(text, 60)}”`;
    if (role) return role;
    const raw = String(sel?.selector ?? "");
    const parts = raw.split(">").map((p: string) => p.trim());
    const lastWithId = [...parts].reverse().find((p) => p.includes("#"));
    if (lastWithId) return lastWithId;
    const lastWithClass = [...parts].reverse().find((p) => p.includes("."));
    if (lastWithClass) return lastWithClass;
    return parts[parts.length - 1] || raw || "<element>";
  };
  const fmt = (s: any): string => {
    if (!s || typeof s !== "object") return String(s);
    if (s.kind === "action") {
      const nm = s.action?.name;
      if (nm === "click" || nm === "dblclick") return `${nm} ${pickNiceSelector(s.selector)}`;
      if (nm === "type") return `type "${s.redacted ? "***" : truncate(String(s.action?.text ?? ""), 40)}" into ${pickNiceSelector(s.selector)}`;
      if (nm === "press") return `press ${s.action?.key}`;
      if (nm === "scroll") return `scroll`;
      if (nm === "navigate") return `navigate to ${shortUrl(String(s.action?.url || ""))}`;
      return nm || "action";
    }
    if (s.kind === "waitForPredicate") {
      return friendlyWait(String(s.predicate));
    }
    return JSON.stringify(s);
  };
  for (const s of steps) {
    const li = document.createElement("li");
    li.textContent = fmt(s);
    ul.appendChild(li);
  }
}

// Settings helpers
type Settings = { allowlistEnabled: boolean; allowedDomains: string[] };
async function readSettings(): Promise<Settings> {
  const res = await chrome.storage.sync.get({ allowlistEnabled: false, allowedDomains: [] as string[] });
  return { allowlistEnabled: Boolean(res.allowlistEnabled), allowedDomains: Array.isArray(res.allowedDomains) ? res.allowedDomains : [] };
}

async function writeSettings(s: Settings): Promise<void> {
  await chrome.storage.sync.set({ allowlistEnabled: s.allowlistEnabled, allowedDomains: s.allowedDomains });
}

function renderDomains(list: string[]) {
  const ul = $("domains") as HTMLUListElement;
  ul.innerHTML = "";
  for (const d of list) {
    const li = document.createElement("li");
    li.textContent = d;
    const btn = document.createElement("button");
    btn.textContent = "Remove";
    btn.addEventListener("click", async () => {
      const s = await readSettings();
      s.allowedDomains = s.allowedDomains.filter((x) => x !== d);
      await writeSettings(s);
      renderDomains(s.allowedDomains);
    });
    li.appendChild(document.createTextNode(" "));
    li.appendChild(btn);
    ul.appendChild(li);
  }
}

// Initialize settings UI
(async () => {
  const s = await readSettings();
  (document.getElementById("allowlistToggle") as HTMLInputElement).checked = s.allowlistEnabled;
  renderDomains(s.allowedDomains);
  // initial preview fetch
  const steps = await fetchPreview();
  if (steps) renderPreview(steps);
})();

document.getElementById("allowlistToggle")?.addEventListener("change", async (ev) => {
  const s = await readSettings();
  s.allowlistEnabled = (ev.target as HTMLInputElement).checked;
  await writeSettings(s);
});

document.getElementById("addDomainBtn")?.addEventListener("click", async () => {
  const input = document.getElementById("domainInput") as HTMLInputElement;
  const raw = (input.value || "").trim();
  if (!raw) return;
  // Normalize: keep hostname only
  let host = raw;
  try {
    if (/^https?:\/\//i.test(raw)) host = new URL(raw).hostname;
  } catch {}
  host = host.replace(/^\*?\.?/, "").toLowerCase();
  const s = await readSettings();
  if (!s.allowedDomains.includes(host)) s.allowedDomains.push(host);
  await writeSettings(s);
  renderDomains(s.allowedDomains);
  input.value = "";
});

$("startBtn").addEventListener("click", async () => {
  const res = await sendToBackground("FRL_POPUP_START");
  setStatus(res?.ok ? "Recording…" : `Error: ${res?.error ?? "unknown"}`);
});

$("stopBtn").addEventListener("click", async () => {
  const res = await sendToBackground("FRL_POPUP_STOP");
  setStatus(res?.ok ? "Stopped" : `Error: ${res?.error ?? "unknown"}`);
});

$("downloadBtn").addEventListener("click", async () => {
  const res = await sendToBackground("FRL_POPUP_DOWNLOAD");
  if (res?.ok) {
    const blob = new Blob([JSON.stringify(res.data ?? { meta: { version: 1 }, steps: [] }, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `frl-steps.json`;
    a.click();
    URL.revokeObjectURL(url);
  } else {
    setStatus(`Error: ${res?.error ?? "unknown"}`);
  }
});

// Periodically refresh preview while popup is open
let previewTimer: number | undefined;
async function refreshPreviewLoop() {
  if (previewTimer) clearTimeout(previewTimer);
  const steps = await fetchPreview();
  if (steps) renderPreview(steps);
  previewTimer = setTimeout(refreshPreviewLoop, 1000) as unknown as number;
}
refreshPreviewLoop();

export {};


