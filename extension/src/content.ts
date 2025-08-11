import { createRecorder } from "./recorder";
import { getSettings, isDomainAllowed } from "./settings.js";

console.log("[FRL] content script loaded");

let recorder = createRecorder();
let isRecording = false;

function dedupeConsecutiveWaits(steps: any[]): any[] {
  const result: any[] = [];
  let lastWaitKey: string | null = null;
  for (const step of steps) {
    // Ensure tabLid stamping defensively
    if (typeof (step as any).tabLid === "undefined") {
      (step as any).tabLid = 1;
    }
    if (step && step.kind === "waitForPredicate") {
      const containerJson = JSON.stringify(step.container ?? null);
      const key = `${step.predicate}|${containerJson}`;
      if (lastWaitKey === key) {
        // skip duplicate consecutive wait
        continue;
      }
      result.push(step);
      lastWaitKey = key;
    } else {
      result.push(step);
      // reset key because only consecutive waits should be deduped
      lastWaitKey = null;
    }
  }
  return result;
}

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
      // De-duplicate consecutive identical wait steps before returning
      try {
        payload.steps = dedupeConsecutiveWaits(payload.steps) as any;
      } catch {}
      sendResponse({ ok: true, data: payload });
      break;
    }
    case "FRL_PREVIEW": {
      const steps = recorder.getRecentSteps(5);
      sendResponse({ ok: true, data: { steps } });
      break;
    }
  }
  // indicate we'll respond synchronously
  return true;
});

export {};
