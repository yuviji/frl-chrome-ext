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

export {};


