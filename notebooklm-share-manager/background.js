// ── Relay to content script ───────────────────────────────────────────────────
// All DOM operations are handled by content.js running in the NotebookLM tab.
// background.js relays messages from the sidebar iframe → content script.

// NotebookLM moved to notebook.google.com in Aug 2026; keep the old host working too.
const NLM_NOTEBOOK_URL = /^https:\/\/notebook(lm)?\.google\.com\/notebook\//;

async function relayToContentScript(msg) {
  // Find the active NotebookLM tab
  const tabs = await chrome.tabs.query({});
  const nlmTab = tabs.find(t => NLM_NOTEBOOK_URL.test(t.url || ''));
  if (!nlmTab) {
    throw new Error('請先開啟 NotebookLM 筆記本頁面');
  }
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(nlmTab.id, msg, (res) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(res);
      }
    });
  });
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const { action } = msg;

  // Keep-alive / registration (no relay needed)
  if (action === 'ping') {
    sendResponse({ ok: true });
    return false;
  }
  if (action === 'registerTab') {
    sendResponse({ ok: true });
    return false;
  }

  // All other actions relay to content.js
  (async () => {
    try {
      const res = await relayToContentScript(msg);
      sendResponse(res);
    } catch (e) {
      sendResponse({ success: false, reason: e.message, error: e.message });
    }
  })();
  return true;
});

// Tab cleanup
chrome.tabs.onRemoved.addListener(() => {});
