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


