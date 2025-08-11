chrome.runtime.onInstalled.addListener(() => {
  console.log("[FRL] extension installed");
});

// relay popup commands to the active tab content script
async function getActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

// Keep a replayer per tab while playing
const tabReplayers = new Map<number, { replayer: CDPReplayer; playing: Promise<void> | null }>();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return;
  const { type } = message as { type?: string };
  if (type === "FRL_POPUP_START" || type === "FRL_POPUP_STOP" || type === "FRL_POPUP_DOWNLOAD" || type === "FRL_POPUP_PREVIEW") {
    (async () => {
      const tabId = await getActiveTabId();
      if (!tabId) {
        sendResponse({ ok: false, error: "No active tab" });
        return;
      }
      const forwardType = type.replace("FRL_POPUP_", "FRL_");
      try {
        const result = await chrome.tabs.sendMessage(tabId, { type: forwardType });
        sendResponse(result);
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // async
  }
  if (type === "FRL_POPUP_PLAY") {
    (async () => {
      try {
        const explicitTabId = (message as any)?.tabId as number | undefined;
        const tabId = explicitTabId ?? (await getActiveTabId());
        if (!tabId) {
          sendResponse({ ok: false, error: "No active tab" });
          return;
        }

        // If an old replayer exists for this tab, stop and dispose it first
        const existing = tabReplayers.get(tabId);
        if (existing) {
          try { await existing.replayer.detach(); } catch {}
          tabReplayers.delete(tabId);
        }

        // Parse inputs
        const trace = (message as any)?.trace as import("./types").TracePayload | string | undefined;
        const thinkScaleRaw = (message as any)?.thinkScale as number | undefined;
        const thinkScale = Number.isFinite(thinkScaleRaw as any) ? (thinkScaleRaw as number) : 1;
        if (!trace) {
          sendResponse({ ok: false, error: "Missing trace" });
          return;
        }
        const parsedTrace: import("./types").TracePayload = typeof trace === "string" ? JSON.parse(trace) : trace;

        const replayer = new CDPReplayer({ tabId });
        tabReplayers.set(tabId, { replayer, playing: null });

        console.log(`[FRL] CDP attach tab=${tabId}`);
        await replayer.attach();

        console.log(`[FRL] CDP play start tab=${tabId} steps=${Array.isArray(parsedTrace?.steps) ? parsedTrace.steps.length : 0}`);
        const playing = replayer.play(parsedTrace, thinkScale);
        tabReplayers.set(tabId, { replayer, playing });
        await playing;

        console.log(`[FRL] CDP detach tab=${tabId}`);
        await replayer.detach();
        tabReplayers.delete(tabId);
        sendResponse({ ok: true });
      } catch (err) {
        // Best-effort cleanup: try to detach and clear if we know the tab
        try {
          const explicitTabId = (message as any)?.tabId as number | undefined;
          const tabId = explicitTabId ?? (await getActiveTabId());
          if (tabId) {
            const maybe = tabReplayers.get(tabId);
            if (maybe) {
              try { await maybe.replayer.detach(); } catch {}
              tabReplayers.delete(tabId);
            }
          }
        } catch {}
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // async
  }
  if (type === "FRL_POPUP_STOP_PLAY") {
    (async () => {
      try {
        const explicitTabId = (message as any)?.tabId as number | undefined;
        const tabId = explicitTabId ?? (await getActiveTabId());
        if (!tabId) {
          sendResponse({ ok: false, error: "No active tab" });
          return;
        }
        const entry = tabReplayers.get(tabId);
        if (!entry) {
          sendResponse({ ok: true });
          return;
        }
        console.log(`[FRL] CDP stop requested tab=${tabId}`);
        try { await entry.replayer.detach(); } catch {}
        tabReplayers.delete(tabId);
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // async
  }
  if (type === "FRL_TEST_CDP_ATTACH") {
    (async () => {
      try {
        const explicitTabId = (message as any)?.tabId as number | undefined;
        const tabId = explicitTabId ?? (await getActiveTabId());
        if (!tabId) {
          sendResponse({ ok: false, error: "No active tab" });
          return;
        }
        const replayer = new CDPReplayer({ tabId });
        await replayer.attach();
        await replayer.detach();
        sendResponse({ ok: true });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // async
  }
});

import { CDPReplayer } from "./replayer";

export {};
