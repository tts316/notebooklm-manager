// 離線測試：以假伺服器取代 pageRpc，驗證 API 模式的讀取與批次判定邏輯。
// 執行：node test/api_batch.test.js
// 重點在「為什麼」：伺服器對無效請求常回空結果不報錯，所以成敗必須靠回讀判定；
// 擁有者不可被動；超過分享上限的新增要回報 skipped 而不是默默送出。
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function load() {
  const noop = () => {};
  const ctx = {
    console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, Date, Math, JSON, Map, Set, Promise,
    location: { pathname: '/notebook/NB1', origin: 'https://notebook.google.com', href: 'x' },
    document: { readyState: 'loading', addEventListener: noop, body: {}, querySelectorAll: () => [], getElementById: () => null },
    window: { addEventListener: noop, removeEventListener: noop, postMessage: noop },
    chrome: { runtime: { onMessage: { addListener: noop }, sendMessage: noop, getURL: s => s } },
    MutationObserver: class { observe() {} },
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../content.js', 'utf8'), ctx);
  return ctx;
}

// 假伺服器：owner + 名單；可設定「靜默拒絕」的 email（回空結果但不生效）
function fakeServer(ctx, users, { limit = 300, silentReject = [], failRead = false, errAfterWrite = false, wholeBatchReject = false, badFormat = false } = {}) {
  const state = new Map(users.map(u => [u[0], u]));
  const calls = [];
  ctx.pageRpc = async (rpcid, params) => {
    calls.push({ rpcid, params });
    if (rpcid === 'JFMDGd') {
      if (failRead) throw new Error('boom');
      return [[...state.values()], [false], limit, true];
    }
    if (rpcid === 'QDyure') {
      const entries = params[0][0][1];
      if (badFormat || (wholeBatchReject && entries.some(e => silentReject.includes(e[0])))) throw new Error("RPC 狀態碼 [3]");
      for (const [email, , perm] of entries) {
        if (silentReject.includes(email)) continue;
        if (perm === 4) state.delete(email);
        else state.set(email, [email, perm, [], [email.split('@')[0]]]);
      }
      if (errAfterWrite) throw new Error("RPC 狀態碼 [3]");
      return [];
    }
    throw new Error('unexpected rpc ' + rpcid);
  };
  // 畫面模擬退回路徑：記錄被交給它的列，回報 error（離線無法真的操作畫面）
  const domRows = [];
  ctx.domBatchProcess = async (rows) => { domRows.push(...rows.map(r => r.email)); return rows.map(r => ({ line: r._line, email: r.email, action: r.action, status: 'error', message: 'DOM' })); };
  return { state, calls, domRows };
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('讀取：一次 RPC 取得全部，權限代碼與姓名正確對應、email 轉小寫', async () => {
  const ctx = load();
  const { calls } = fakeServer(ctx, [
    ['Owner@x.com', 1, [], ['老闆']], ['a@x.com', 3, [], ['甲']], ['b@x.com', 2, [], null],
  ]);
  const r = await ctx.apiReadUsers();
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(r.mode, 'api');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(r.users)).map(u => [u.email, u.role, u.name]), [
    ['owner@x.com', 'owner', '老闆'], ['a@x.com', 'reader', '甲'], ['b@x.com', 'writer', 'b@x.com'],
  ]);
});

test('批次：移除／改權限／新增一次處理，成敗依回讀結果判定', async () => {
  const ctx = load();
  const { state } = fakeServer(ctx, [
    ['owner@x.com', 1, [], ['O']], ['a@x.com', 3, [], ['A']], ['b@x.com', 3, [], ['B']],
  ], { silentReject: ['bad@x.com'] });
  const res = await ctx.apiBatchProcess([
    { _line: 1, action: 'remove', email: 'a@x.com' },
    { _line: 2, action: 'remove', email: 'nobody@x.com' },
    { _line: 3, action: 'remove', email: 'owner@x.com' },
    { _line: 4, action: 'update', email: 'B@x.com', role: 'writer' },
    { _line: 5, action: 'add', email: 'new@x.com', role: 'reader' },
    { _line: 6, action: 'add', email: 'bad@x.com', role: 'reader' },
    { _line: 7, action: 'add', email: 'new@x.com', role: 'writer' },
  ]).then(r => JSON.parse(JSON.stringify(r)));
  const by = Object.fromEntries(res.map(r => [r.line, r.status + (r.message ? ':' + r.message : '')]));
  assert.strictEqual(by[1], 'success');
  assert.match(by[2], /^error:找不到/);
  assert.match(by[3], /^error:無法移除擁有者/);
  assert.strictEqual(by[4], 'success');
  assert.strictEqual(by[5], 'success');
  assert.match(by[6], /^error:DOM.*改用畫面模擬/);   // 伺服器靜默拒絕不能被當成成功，且要交給畫面模擬重試
  assert.match(by[7], /^error:CSV 內重複/);
  assert.ok(!state.has('a@x.com') && state.get('b@x.com')[1] === 2 && state.has('owner@x.com'));
  assert.deepStrictEqual(res.map(r => r.line), [1, 2, 3, 4, 5, 6, 7]);
});

test('批次：超過分享上限的新增回報 skipped，不送出', async () => {
  const ctx = load();
  const { calls } = fakeServer(ctx, [['owner@x.com', 1, [], null], ['a@x.com', 3, [], null]], { limit: 3 });
  const res = await ctx.apiBatchProcess([
    { _line: 1, action: 'add', email: 'n1@x.com', role: 'reader' },
    { _line: 2, action: 'add', email: 'n2@x.com', role: 'reader' },
  ]).then(r => JSON.parse(JSON.stringify(r)));
  assert.deepStrictEqual(res.map(r => r.status), ['success', 'skipped']);
  const sentEmails = calls.filter(c => c.rpcid === 'QDyure').flatMap(c => c.params[0][0][1].map(e => e[0]));
  assert.deepStrictEqual(sentEmails, ['n1@x.com']);
});

test('寫入時 RPC 回錯誤碼但回讀已生效 → 判成功（不可只看 RPC 回應）', async () => {
  const ctx = load();
  fakeServer(ctx, [['owner@x.com', 1, [], null], ['a@x.com', 3, [], null]], { errAfterWrite: true });
  const res = await ctx.apiBatchProcess([
    { _line: 1, action: 'add', email: 'n@x.com', role: 'writer' },
    { _line: 2, action: 'remove', email: 'a@x.com' },
  ]).then(r => JSON.parse(JSON.stringify(r)));
  assert.deepStrictEqual(res.map(r => r.status), ['success', 'success']);
});

test('整包被拒時逐筆重送：只有真正有問題的帳號失敗，其餘成功', async () => {
  const ctx = load();
  const { state, domRows } = fakeServer(ctx, [['owner@x.com', 1, [], null]], { wholeBatchReject: true, silentReject: ['bad@x.com'] });
  const res = await ctx.apiBatchProcess([
    { _line: 1, action: 'add', email: 'a@x.com', role: 'reader' },
    { _line: 2, action: 'add', email: 'bad@x.com', role: 'reader' },
    { _line: 3, action: 'add', email: 'c@x.com', role: 'writer' },
  ]).then(r => JSON.parse(JSON.stringify(r)));
  assert.deepStrictEqual(res.map(r => r.status), ['success', 'error', 'success']);
  assert.ok(state.has('a@x.com') && state.has('c@x.com'));
  assert.deepStrictEqual(domRows, ['bad@x.com']);
});

test('格式錯誤（逐筆也全失敗）時只試 3 筆就停，其餘整批交給畫面模擬', async () => {
  const ctx = load();
  const { calls, domRows } = fakeServer(ctx, [['owner@x.com', 1, [], null]], { badFormat: true });
  const rows = Array.from({ length: 10 }, (_, n) => ({ _line: n + 1, action: 'add', email: 'u' + n + '@x.com', role: 'reader' }));
  await ctx.apiBatchProcess(rows);
  assert.strictEqual(calls.filter(c => c.rpcid === 'QDyure').length, 1 + 3);  // 1 次整批 + 3 次逐筆
  assert.strictEqual(domRows.length, 10);
});

test('API 讀取失敗時退回畫面模擬（功能不中斷）', async () => {
  const ctx = load();
  fakeServer(ctx, [], { failRead: true });
  const r = await ctx.apiOrDom('readUsers', ctx.apiReadUsers, async () => ({ success: true, users: [] }));
  assert.strictEqual(r.mode, 'dom');
});

(async () => {
  let fail = 0;
  for (const [name, fn] of tests) {
    try { await fn(); console.log('✓', name); }
    catch (e) { fail++; console.log('✗', name, '\n ', e.message); }
  }
  console.log(fail ? `${fail} 項失敗` : `全部 ${tests.length} 項通過`);
  process.exit(fail ? 1 : 0);
})();
