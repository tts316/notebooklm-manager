// 離線測試：Share Manager「依標籤同步」判定（排程 ⑮ notebooklm/nlm_sync.py 也走這套）。
// 執行：node test/sync_labels.test.js
// 重點：學管下載的通訊錄已含「0待刪除名單」；超過 300 人（不含擁有者）時，
// 先排除「外語」單位新進者、再排除其他新進者（都依到職日由新到舊），且被排除者不可被送出；
// 擴充程式僅限「聯成人AI」筆記本（2026-10-08 使用者規則）。
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

function load() {
  const el = () => ({ classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, style: {} });
  const ctx = {
    console, setTimeout, clearTimeout, URLSearchParams,
    document: { addEventListener() {}, getElementById: el, querySelectorAll: () => [], createElement: el },
    window: { addEventListener() {}, parent: { postMessage() {} } },
    chrome: { runtime: { sendMessage() {} }, storage: { local: { get() {}, set() {} } } },
    location: { search: '' },
  };
  ctx.window = Object.assign(ctx, ctx.window);
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(__dirname + '/../sidebar.js', 'utf8'), ctx);
  vm.runInContext('showToast = () => {}; switchTab = () => {}; renderCSVPreview = () => {};', ctx);
  return ctx;
}

function run(ctx, perms, contacts, notebookOk = true) {
  ctx.__perms = perms; ctx.__contacts = contacts; ctx.window.__nlmNotebookOk = notebookOk;
  vm.runInContext('allPermissions = __perms; contactsMap = __contacts; csvRows = []; syncSharingByLabels();', ctx);
  return JSON.parse(JSON.stringify(vm.runInContext('csvRows', ctx)));
}

const owner = { email: 'owner@x.com', role: 'owner' };
const shared = n => Array.from({ length: n }, (_, i) => ({ email: `s${i}@x.com`, role: 'reader' }));
const c = (labels, joinDate = '2020/01/01') => ({ name: 'n', labels, joinDate });

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('0待刪除名單且在名單 → 移除；其他標籤且不在名單 → 加入；已在名單 → 不動', () => {
  const ctx = load();
  const rows = run(ctx, [owner, { email: 'a@x.com', role: 'reader' }, { email: 'b@x.com', role: 'reader' }], {
    'a@x.com': c(['0待刪除名單']), 'b@x.com': c(['聯成_台南']), 'n@x.com': c(['聯成_台南']), 'd@x.com': c(['0待刪除名單']),
  });
  assert.deepStrictEqual(rows.map(r => [r.email, r.action, r._errors.length]),
    [['a@x.com', 'remove', 0], ['n@x.com', 'add', 0]]);
});

test('超過 300：外語新進者依到職日由新到舊排除，非外語優先佔名額', () => {
  const ctx = load();
  const contacts = {
    'f_old@x.com': c(['聯成_外語課服處'], '2024/01/01'),
    'f_new@x.com': c(['聯成_外語業務一處'], '2026/09/01'),
    'tw@x.com': c(['聯成_台南'], '2026/10/01'),
  };
  const rows = run(ctx, [owner, ...shared(298)], contacts);   // 名額剩 2，要加 3 人
  const err = Object.fromEntries(rows.map(r => [r.email, r._errors.join()]));
  assert.strictEqual(err['tw@x.com'], '');
  assert.strictEqual(err['f_old@x.com'], '');
  assert.match(err['f_new@x.com'], /外語單位新進者暫不加入/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.window.__nlmLastSync.capped)), { foreign: 1, other: 0 });
});

test('移除會騰出名額；外語全排仍不足時非外語也依到職日暫緩', () => {
  const ctx = load();
  const perms = [owner, ...shared(300)];
  const contacts = { 's0@x.com': c(['0待刪除名單']), 'a@x.com': c(['聯成_台南']), 'b@x.com': c(['聯成_高雄']), 'f@x.com': c(['聯成_外語部']) };
  const rows = run(ctx, perms, contacts);   // 移除 1 → 名額 1，要加 3（1 外語）
  const errs = rows.filter(r => r._errors.length).map(r => r._errors[0]);
  assert.strictEqual(errs.length, 2);
  assert.ok(errs.some(e => /外語/.test(e)) && errs.some(e => /依到職日/.test(e)));
});

test('非外語新進者超額時，最新到職者先暫緩', () => {
  const ctx = load();
  const contacts = { 'old@x.com': c(['聯成_台南'], '2026/09/01'), 'new@x.com': c(['聯成_板橋'], '2026/10/07'),
                     'mid@x.com': c(['聯成_高雄'], '2026/09/15') };
  const rows = run(ctx, [owner, ...shared(298)], contacts);   // 名額剩 2，要加 3 人
  const err = Object.fromEntries(rows.map(r => [r.email, r._errors.join()]));
  assert.strictEqual(err['old@x.com'], '');
  assert.strictEqual(err['mid@x.com'], '');
  assert.match(err['new@x.com'], /依到職日（新到舊）暫不加入/);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(ctx.window.__nlmLastSync.capped)), { foreign: 0, other: 1 });
});

test('不是「聯成人AI」筆記本 → 拒絕同步，不產生任何變更', () => {
  const ctx = load();
  const rows = run(ctx, [owner, { email: 'a@x.com', role: 'reader' }], { 'a@x.com': c(['0待刪除名單']), 'n@x.com': c(['聯成_台南']) }, false);
  assert.deepStrictEqual(rows, []);
  assert.strictEqual(ctx.window.__nlmLastSync.blocked, true);
});

let fail = 0;
for (const [name, fn] of tests) {
  try { fn(); console.log('✓', name); } catch (e) { fail++; console.log('✗', name, '\n ', e.message); }
}
console.log(fail ? `${fail} 項失敗` : `全部 ${tests.length} 項通過`);
process.exit(fail ? 1 : 0);
