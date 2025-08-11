import { createRecorder } from "./recorder";

console.log("[FRL] content script loaded");

let recorder = createRecorder();
let isRecording = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  const { type } = message as { type?: string };
  switch (type) {
    case "FRL_START": {
      isRecording = true;
      recorder.start();
      console.log("[FRL] recording started");
      sendResponse({ ok: true });
      break;
    }
    case "FRL_STOP": {
      isRecording = false;
      recorder.stop();
      console.log("[FRL] recording stopped");
      sendResponse({ ok: true });
      break;
    }
    case "FRL_DOWNLOAD": {
      const payload = recorder.dump();
      sendResponse({ ok: true, data: payload });
      break;
    }
  }
  // indicate we'll respond synchronously
  return true;
});

export {};
