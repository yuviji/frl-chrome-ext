chrome.runtime.onInstalled.addListener(() => {
  console.log("[FRL] extension installed");
});

// relay popup commands to the active tab content script
async function getActiveTabId(): Promise<number | null> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id ?? null;
}

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
