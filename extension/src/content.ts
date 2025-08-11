import { buildSelector } from "./selector";

console.log("[FRL] content script loaded");

let isRecording = false;
type RecordedStep = {
  type: string;
  selector: ReturnType<typeof buildSelector>;
  tabLid?: number;
  timestamp: number;
};

let recordedSteps: RecordedStep[] = [];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  const { type } = message as { type?: string };
  switch (type) {
    case "FRL_START": {
      isRecording = true;
      recordedSteps = [];
      attachEventListeners();
      console.log("[FRL] recording started");
      sendResponse({ ok: true });
      break;
    }
    case "FRL_STOP": {
      isRecording = false;
      detachEventListeners();
      console.log("[FRL] recording stopped");
      sendResponse({ ok: true });
      break;
    }
    case "FRL_DOWNLOAD": {
      // Return empty skeleton for now
      const payload = { meta: { version: 1 }, steps: recordedSteps };
      sendResponse({ ok: true, data: payload });
      break;
    }
  }
  // indicate we'll respond synchronously
  return true;
});

export {};

// Minimal event capture for clicks and keypress
function onClick(ev: MouseEvent) {
  if (!isRecording) return;
  const path = (ev.composedPath && ev.composedPath()) || [];
  const target = (path[0] as Element) || (ev.target as Element | null);
  if (!target || !(target instanceof Element)) return;
  const selector = buildSelector(target);
  recordedSteps.push({ type: "click", selector, timestamp: Date.now() });
}

function onKeydown(ev: KeyboardEvent) {
  if (!isRecording) return;
  const target = ev.target as Element | null;
  if (!target || !(target instanceof Element)) return;
  const selector = buildSelector(target);
  recordedSteps.push({ type: "keydown", selector, timestamp: Date.now() });
}

function attachEventListeners() {
  window.addEventListener("click", onClick, true);
  window.addEventListener("keydown", onKeydown, true);
}

function detachEventListeners() {
  window.removeEventListener("click", onClick, true);
  window.removeEventListener("keydown", onKeydown, true);
}
