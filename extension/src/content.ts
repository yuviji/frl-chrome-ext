console.log("[FRL] content script loaded");

let isRecording = false;
let recordedSteps: unknown[] = [];

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  const { type } = message as { type?: string };
  switch (type) {
    case "FRL_START": {
      isRecording = true;
      recordedSteps = [];
      console.log("[FRL] recording started");
      sendResponse({ ok: true });
      break;
    }
    case "FRL_STOP": {
      isRecording = false;
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
