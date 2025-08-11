import { createRecorder } from "./recorder";
import { getSettings, isDomainAllowed } from "./settings.js";

console.log("[FRL] content script loaded");

let recorder = createRecorder();
let isRecording = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  const { type } = message as { type?: string };
  switch (type) {
    case "FRL_START": {
      (async () => {
        try {
          const settings = await getSettings();
          const hostname = location.hostname;
          if (settings.allowlistEnabled && !isDomainAllowed(hostname, settings.allowedDomains)) {
            console.log("[FRL] allowlist enabled; domain not allowed → skipping start");
            sendResponse({ ok: false, error: "Domain not allowlisted" });
            return;
          }
          isRecording = true;
          recorder.start();
          console.log("[FRL] recording started");
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: String(err) });
        }
      })();
      return true;
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
