// Runs in PAGE context (not content script context).
// Intercepts fetch/XHR to capture Google API Bearer tokens.
(function () {
  function broadcast(token) {
    window.postMessage({ __nlmSM: true, token }, location.origin);
  }

  // ── Intercept fetch ────────────────────────────────────────────────────────
  const origFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input?.url || '');
      if (url.includes('googleapis.com') || url.includes('accounts.google.com')) {
        const headers = init?.headers;
        let auth = null;
        if (headers instanceof Headers) {
          auth = headers.get('Authorization');
        } else if (headers && typeof headers === 'object') {
          auth = headers['Authorization'] || headers['authorization'];
        }
        if (auth?.startsWith('Bearer ')) broadcast(auth.slice(7));
      }
    } catch (_) {}
    return origFetch(input, init);
  };

  // ── Intercept XMLHttpRequest ───────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSetHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this.__nlmUrl = url || '';
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (
      (this.__nlmUrl?.includes('googleapis.com') || this.__nlmUrl?.includes('accounts.google.com')) &&
      name.toLowerCase() === 'authorization' &&
      value?.startsWith('Bearer ')
    ) {
      broadcast(value.slice(7));
    }
    return origSetHeader.apply(this, arguments);
  };
})();
