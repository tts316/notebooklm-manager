// Runs in MAIN world — can hook window.fetch and XMLHttpRequest directly.
// Forwards any Bearer token it sees to the isolated-world content script via postMessage.
(function () {
  'use strict';

  function extractAndPost(headers) {
    if (!headers) return;
    let auth;
    if (typeof headers === 'string') {
      auth = headers;
    } else if (typeof Headers !== 'undefined' && headers instanceof Headers) {
      auth = headers.get('authorization') || headers.get('Authorization');
    } else if (typeof headers === 'object') {
      auth = headers['Authorization'] || headers['authorization'];
    }
    if (!auth) return;

    let token = null;
    if (auth.startsWith('Bearer ')) token = auth.slice(7);
    else if (/^ya29\./.test(auth)) token = auth;

    if (token && token.length > 30) {
      window.postMessage({ __nlm_sm_token: token }, '*');
    }
  }

  // ── Hook fetch ────────────────────────────────────────────────────────────
  const _fetch = window.fetch;
  window.fetch = function (resource, init) {
    try {
      if (init && init.headers) extractAndPost(init.headers);
      else if (resource instanceof Request) extractAndPost(resource.headers);
    } catch (_) {}
    return _fetch.apply(this, arguments);
  };

  // ── Hook XHR ──────────────────────────────────────────────────────────────
  const _setRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    try {
      if (typeof name === 'string' && name.toLowerCase() === 'authorization') {
        extractAndPost(value);
      }
    } catch (_) {}
    return _setRequestHeader.apply(this, arguments);
  };
})();

// ── RPC bridge (v2.0) ─────────────────────────────────────────────────────────
// 分享名單改走 NotebookLM 前端自己用的 batchexecute RPC（跟學管/CAAC 一樣直接打 API），
// 不再開分享框逐筆捲動。必須在 MAIN world 執行：要讀頁面的 WIZ_global_data
// （CSRF token `SNlM0e`、session id `FdrFJe`、build label `cfb2h`），並帶頁面 cookie。
// RPC 代號與參數格式參考 teng-lin/notebooklm-py（docs/rpc-reference.md）：
//   JFMDGd = 讀取分享狀態（一次回傳全部使用者）
//   QDyure = 新增／改權限／移除（權限 2=編輯者 3=檢視者 4=移除）
(function () {
  'use strict';
  const fetchFn = window.fetch; // 上面 hook 過的 fetch 也能用，只是不必再經過攔截
  let reqid = Math.floor(Math.random() * 900000) + 100000;

  function parseBatchResponse(text, rpcid) {
    // 回應開頭是防 XSSI 的 `)]}'`，之後是「長度行 + JSON 行」交錯的 chunk
    const lines = text.replace(/^\)\]\}'\s*/, '').split('\n');
    for (const line of lines) {
      const s = line.trim();
      if (!s.startsWith('[')) continue;
      let chunk;
      try { chunk = JSON.parse(s); } catch (_) { continue; }
      for (const e of chunk) {
        if (!Array.isArray(e)) continue;
        if (e[0] === 'er') throw new Error('RPC 回傳錯誤：' + JSON.stringify(e).slice(0, 200));
        if (e[0] === 'wrb.fr' && e[1] === rpcid) {
          if (e[5] && Array.isArray(e[5]) && e[5].length) {
            throw new Error('RPC 狀態碼 ' + JSON.stringify(e[5]).slice(0, 100));
          }
          return e[2] == null ? null : JSON.parse(e[2]);
        }
      }
    }
    throw new Error('RPC 回應中找不到 ' + rpcid);
  }

  async function rpc(rpcid, params, sourcePath) {
    const w = window.WIZ_global_data;
    if (!w || !w.SNlM0e) throw new Error('頁面尚未載入完成（找不到 WIZ_global_data）');
    reqid += 100000;
    const qs = new URLSearchParams({
      rpcids: rpcid,
      'source-path': sourcePath || location.pathname,
      bl: w.cfb2h || '',
      'f.sid': w.FdrFJe || '',
      hl: document.documentElement.lang || 'zh-TW',
      _reqid: String(reqid),
      rt: 'c',
    });
    const fReq = JSON.stringify([[[rpcid, JSON.stringify(params), null, 'generic']]]);
    const body = 'f.req=' + encodeURIComponent(fReq) + '&at=' + encodeURIComponent(w.SNlM0e) + '&';
    const res = await fetchFn.call(window, location.origin + '/_/LabsTailwindUi/data/batchexecute?' + qs, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Same-Domain': '1' },
      body,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return parseBatchResponse(await res.text(), rpcid);
  }

  window.addEventListener('message', async (e) => {
    if (e.source !== window || !e.data || !e.data.__nlm_rpc_req) return;
    const { id, rpcid, params, sourcePath } = e.data.__nlm_rpc_req;
    let reply;
    try { reply = { id, ok: true, data: await rpc(rpcid, params, sourcePath) }; }
    catch (err) { reply = { id, ok: false, error: String(err && err.message || err) }; }
    window.postMessage({ __nlm_rpc_res: reply }, location.origin);
  });
})();

// ── 診斷：記錄 NotebookLM 介面自己送出的分享請求（v2.0.1）────────────────────
// API 寫入若被拒（[3]），在分享框手動加一個人，console 會印出網頁版實際使用的
// QDyure 參數格式，可據此比對修正 content.js 的 shareParams()。
(function () {
  'use strict';
  const _open = XMLHttpRequest.prototype.open;
  const _send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__nlmSmUrl = String(url || '');
    return _open.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (this.__nlmSmUrl.includes('rpcids=QDyure') && typeof body === 'string') {
        const m = body.match(/(?:^|&)f\.req=([^&]*)/);
        console.info('[NLM-SM] 介面送出的 QDyure：', m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : body);
      }
    } catch (_) {}
    return _send.apply(this, arguments);
  };
  // RPC 橋接用的是先前取得的 fetch，不會經過這裡，只會記到介面自己的請求
  const _fetch2 = window.fetch;
  window.fetch = function (resource, init) {
    try {
      const url = typeof resource === 'string' ? resource : (resource && resource.url) || '';
      const body = init && init.body;
      if (url.includes('rpcids=QDyure') && typeof body === 'string') {
        const m = body.match(/(?:^|&)f\.req=([^&]*)/);
        console.info('[NLM-SM] 介面送出的 QDyure：', m ? decodeURIComponent(m[1].replace(/\+/g, ' ')) : body);
      }
    } catch (_) {}
    return _fetch2.apply(this, arguments);
  };
})();
