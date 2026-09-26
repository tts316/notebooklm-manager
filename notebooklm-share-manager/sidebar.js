// ── State ─────────────────────────────────────────────────────────────────────
let allPermissions = [];
let csvRows = [];
let contactsMap = {}; // email (lowercase) → display name from Google Contacts

const ROLE_LABELS = { owner:'擁有者', writer:'編輯者', commenter:'留言者', reader:'檢視者' };
const ROLE_BADGE  = { owner:'badge-owner', writer:'badge-writer', commenter:'badge-commenter', reader:'badge-reader' };
const ACTION_LABELS = { add:'新增', update:'更新', remove:'移除' };

// ── Utilities ─────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function showToast(msg, type = 'info', duration = 2800) {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${type}`;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => el.classList.add('hidden'), duration);
}

function sendMsg(data) {
  return new Promise((resolve, reject) => {
    // After the extension is reloaded/updated, this orphaned iframe loses its
    // connection — chrome.runtime becomes undefined, so calling sendMessage on
    // it throws "Cannot read properties of undefined". Detect that up front and
    // give a clear recovery step (refresh re-injects a fresh context).
    if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
      reject(new Error('擴充程式連線已中斷（可能剛重新載入過），請重新整理 NotebookLM 頁面後再開啟 Share Manager'));
      return;
    }
    try {
      chrome.runtime.sendMessage(data, (res) => {
        if (chrome.runtime.lastError) {
          const msg = chrome.runtime.lastError.message || '';
          if (/context invalidated/i.test(msg)) {
            reject(new Error('擴充程式已重新載入，請關閉 Share Manager 後重新開啟'));
          } else {
            resolve(null); // other non-fatal errors: let callers handle via !res check
          }
          return;
        }
        resolve(res);
      });
    } catch (e) {
      if (/context invalidated/i.test(e.message || '')) {
        reject(new Error('擴充程式已重新載入，請關閉 Share Manager 後重新開啟'));
      } else {
        reject(e);
      }
    }
  });
}

function isValidEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()); }

function avatarInitial(name, email) {
  if (name && name !== email) return name.trim()[0];
  return (email || '?')[0];
}

function avatarColor(str) {
  const cols = ['#1D4ED8','#7C3AED','#065F46','#9A3412','#0369A1','#6D28D9'];
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) & 0xFFFFFF;
  return cols[Math.abs(h) % cols.length];
}

function escHtml(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── API (relayed to content.js via background) ────────────────────────────────
async function apiCall(data) {
  const res = await sendMsg(data);
  if (!res) throw new Error('無法連線至背景程式，請重新整理頁面');
  if (!res.success && res.reason) {
    const err = new Error(res.reason);
    throw err;
  }
  if (res.error) throw new Error(res.error);
  return res;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const params = new URLSearchParams(location.search);
  const notebookId = params.get('notebookId');

  if (!notebookId) {
    showError('找不到筆記本 ID', '請確認目前頁面是 NotebookLM 筆記本頁面');
    return;
  }

  $('notebookName').textContent = notebookId.slice(0, 8) + '…';

  // Load cached contacts before rendering so names appear immediately
  await loadContactsFromStorage();
  await loadMainContent();
}

async function loadMainContent() {
  $('errorState').classList.add('hidden');
  $('mainContent').classList.remove('hidden');
  await loadUsers();
}

function showError(title, desc) {
  $('mainContent').classList.add('hidden');
  $('errorTitle').textContent = title;
  $('errorDesc').textContent = desc;
  $('errorState').classList.remove('hidden');
}

// ── Users ─────────────────────────────────────────────────────────────────────
async function loadUsers() {
  const list = $('usersList');
  list.innerHTML = `<div class="loading-row"><div class="spinner"></div><span>正在讀取分享清單…</span></div>`;
  $('noUsers').classList.add('hidden');
  $('noResults').classList.add('hidden');

  try {
    const data = await sendMsg({ action: 'readUsers' });
    if (!data) throw new Error('無法連線至分頁，請重新整理 NotebookLM 頁面');
    if (!data.success) throw new Error(data.reason || '讀取失敗');

    allPermissions = data.users || [];
    enrichWithContacts(); // apply cached contact names (no-op if contactsMap is empty)
    updateUserCount();
    renderUsers($('searchInput').value.trim());
    // 標示讀取方式：API 應在 1 秒內完成；出現「畫面模擬」代表 API 失效、已自動退回舊流程
    showToast(data.mode === 'api'
      ? `已讀取 ${allPermissions.length} 位（API ${(data.ms / 1000).toFixed(1)} 秒）`
      : `已讀取 ${allPermissions.length} 位（API 無法使用，已改用畫面模擬）`,
      data.mode === 'api' ? 'info' : 'error', 3000);
  } catch (e) {
    list.innerHTML = `<div class="loading-row" style="color:#F87171">載入失敗：${escHtml(e.message)}</div>`;
  }
}

function updateUserCount() {
  const nonOwner = allPermissions.filter(p => p.role !== 'owner').length;
  $('userCount').textContent = nonOwner || '';
}

function renderUsers(filter = '') {
  const list = $('usersList');
  const q = filter.toLowerCase();
  const filtered = allPermissions.filter(p =>
    !q ||
    p.email?.toLowerCase().includes(q) ||
    p.name?.toLowerCase().includes(q) ||
    p.labels?.some(l => l.toLowerCase().includes(q))
  );

  list.innerHTML = '';

  if (allPermissions.length === 0) {
    $('noUsers').classList.remove('hidden'); return;
  }
  $('noUsers').classList.add('hidden');

  if (filtered.length === 0) {
    $('noResults').classList.remove('hidden'); return;
  }
  $('noResults').classList.add('hidden');

  for (const perm of filtered) list.appendChild(buildRow(perm));
}

function buildRow(perm) {
  const row = document.createElement('div');
  row.className = 'user-row';
  row.dataset.email = perm.email;

  const initials = avatarInitial(perm.name, perm.email);
  const color = avatarColor(perm.email || perm.name || '?');
  const isOwner = perm.role === 'owner';
  const name = perm.name || perm.email || '未知用戶';

  const labelsHtml = (perm.labels?.length)
    ? `<div class="user-labels">${perm.labels.map(l => `<span class="label-chip">${escHtml(l)}</span>`).join('')}</div>`
    : '';
  const dateHtml = perm.joinDate
    ? `<div class="user-date">到職 ${escHtml(perm.joinDate)}</div>` : '';

  row.innerHTML = `
    <div class="avatar" style="background:${color}">${escHtml(initials)}</div>
    <div class="user-info">
      <div class="user-name">${escHtml(name)}</div>
      ${labelsHtml}
      ${perm.email && perm.email !== name
        ? `<div class="user-email">${escHtml(perm.email)}</div>` : ''}
      ${dateHtml}
    </div>
    <div class="user-role">
      <span class="badge ${ROLE_BADGE[perm.role] || 'badge-reader'}">${ROLE_LABELS[perm.role] || perm.role}</span>
    </div>
    <div class="user-actions">
      ${isOwner ? '' : `
        <button class="btn-icon edit-btn" title="修改權限">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="btn-icon danger delete-btn" title="移除">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      `}
    </div>
  `;

  if (!isOwner) {
    row.querySelector('.edit-btn').addEventListener('click', () => enterEdit(row, perm));
    row.querySelector('.delete-btn').addEventListener('click', () => deleteUser(perm));
  }
  return row;
}

function enterEdit(row, perm) {
  document.querySelectorAll('.user-row.editing').forEach(r => {
    if (r !== row) exitEdit(r);
  });
  row.classList.add('editing');

  const roleDiv = row.querySelector('.user-role');
  const actDiv  = row.querySelector('.user-actions');

  roleDiv.innerHTML = `
    <select class="role-select-inline">
      <option value="reader"    ${perm.role==='reader'    ?'selected':''}>檢視者</option>
      <option value="commenter" ${perm.role==='commenter' ?'selected':''}>留言者</option>
      <option value="writer"    ${perm.role==='writer'    ?'selected':''}>編輯者</option>
    </select>`;

  actDiv.innerHTML = `
    <button class="btn-icon success save-btn" title="儲存">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </button>
    <button class="btn-icon cancel-edit-btn" title="取消">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>`;

  actDiv.querySelector('.save-btn').addEventListener('click', async () => {
    const newRole = roleDiv.querySelector('.role-select-inline').value;
    if (newRole === perm.role) { exitEdit(row); return; }
    actDiv.querySelector('.save-btn').disabled = true;
    showToast('正在更新權限，請勿操作頁面…', 'info', 8000);
    try {
      const res = await sendMsg({ action: 'updateUser', email: perm.email, role: newRole });
      if (!res?.success) throw new Error(res?.reason || '更新失敗');
      showToast(`已更新 ${perm.email} 的權限`, 'success');
      // Local update — no need to re-scan the full list
      const idx = allPermissions.findIndex(p => p.email === perm.email);
      if (idx !== -1) allPermissions[idx].role = newRole;
      perm.role = newRole;
      renderUsers($('searchInput').value.trim());
    } catch (e) {
      showToast(`更新失敗：${e.message}`, 'error');
      exitEdit(row);
    }
  });
  actDiv.querySelector('.cancel-edit-btn').addEventListener('click', () => exitEdit(row));
}

function exitEdit(row) {
  const email = row.dataset.email;
  const perm = allPermissions.find(p => p.email === email);
  if (perm) row.replaceWith(buildRow(perm));
}

async function deleteUser(perm) {
  const name = perm.name || perm.email || '此用戶';
  if (!confirm(`確定要移除「${name}」的分享權限嗎？`)) return;
  showToast('正在移除，請勿操作頁面…', 'info', 8000);
  try {
    const res = await sendMsg({ action: 'removeUser', email: perm.email });
    if (!res?.success) throw new Error(res?.reason || '移除失敗');
    showToast(`已移除 ${name}`, 'success');
    // Local update — no need to re-scan the full list
    allPermissions = allPermissions.filter(p => p.email !== perm.email);
    updateUserCount();
    renderUsers($('searchInput').value.trim());
  } catch (e) {
    showToast(`移除失敗：${e.message}`, 'error');
  }
}

// ── Add user ──────────────────────────────────────────────────────────────────
function showAddForm() {
  $('addUserForm').classList.remove('hidden');
  $('addUserBtn').classList.add('hidden');
  $('newEmail').value = '';
  $('newRole').value = 'reader';
  hideFieldError();
  $('newEmail').focus();
}
function hideAddForm() {
  $('addUserForm').classList.add('hidden');
  $('addUserBtn').classList.remove('hidden');
}
function showFieldError(msg) {
  $('emailError').textContent = msg;
  $('emailError').classList.remove('hidden');
  $('newEmail').classList.add('error');
  $('newEmail').focus();
}
function hideFieldError() {
  $('emailError').classList.add('hidden');
  $('newEmail').classList.remove('error');
}

async function confirmAdd() {
  const email = $('newEmail').value.trim();
  const role  = $('newRole').value;
  hideFieldError();

  if (!email)               { showFieldError('請輸入電子郵件'); return; }
  if (!isValidEmail(email)) { showFieldError('電子郵件格式不正確'); return; }
  if (allPermissions.some(p => p.email?.toLowerCase() === email.toLowerCase()))
    { showFieldError('此用戶已在分享清單中'); return; }

  $('confirmAddBtn').disabled = true;
  $('confirmAddBtn').textContent = '新增中…';
  showToast('正在新增，請勿操作頁面…', 'info', 10000);

  try {
    const res = await sendMsg({ action: 'addUser', email: email.toLowerCase(), role });
    if (!res?.success) throw new Error(res?.reason || '新增失敗');
    showToast(`已新增 ${email}`, 'success');
    hideAddForm();
    // Local update — build a new perm entry and enrich with contacts if available
    const newPerm = { email: email.toLowerCase(), name: email.toLowerCase(), role, labels: [], joinDate: '' };
    const contactEntry = contactsMap[email.toLowerCase()];
    if (contactEntry) {
      if (typeof contactEntry === 'string') {
        newPerm.name = contactEntry;
      } else {
        newPerm.name     = contactEntry.name     || newPerm.name;
        newPerm.labels   = contactEntry.labels   || [];
        newPerm.joinDate = contactEntry.joinDate || '';
      }
    }
    allPermissions.push(newPerm);
    updateUserCount();
    renderUsers($('searchInput').value.trim());
  } catch (e) {
    showToast(`新增失敗：${e.message}`, 'error');
  } finally {
    $('confirmAddBtn').disabled = false;
    $('confirmAddBtn').textContent = '新增用戶';
  }
}

// ── Search ────────────────────────────────────────────────────────────────────
function onSearch() {
  const q = $('searchInput').value.trim();
  $('clearSearch').classList.toggle('hidden', !q);
  renderUsers(q);
}

// ── CSV ───────────────────────────────────────────────────────────────────────
const VALID_ROLES   = new Set(['reader','commenter','writer']);
const VALID_ACTIONS = new Set(['add','update','remove']);

function parseCSV(text) {
  const rows = [];
  let lineNum = 0;
  for (const raw of text.replace(/\r\n/g,'\n').replace(/\r/g,'\n').split('\n')) {
    lineNum++;
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) continue;
    if (lineNum === 1 && /^email/i.test(line)) continue;

    const parts = line.split(',').map(s => s.trim().replace(/^["']|["']$/g,''));
    const [email='', role='', action=''] = parts;
    const errs = [];
    if (!email)                  errs.push('缺少 email');
    else if (!isValidEmail(email)) errs.push('email 格式錯誤');

    const al = action.toLowerCase(), rl = role.toLowerCase();
    if (!VALID_ACTIONS.has(al))                    errs.push(`action 無效（${action||'空白'}）`);
    if (al !== 'remove' && !VALID_ROLES.has(rl))   errs.push(`role 無效（${role||'空白'}）`);

    rows.push({ _line:lineNum, email:email.toLowerCase(), role:rl, action:al, _errors:errs });
  }
  return rows;
}

function handleCSVFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = e => {
    csvRows = parseCSV(e.target.result);
    if (!csvRows.length) { showToast('CSV 沒有有效資料', 'error'); return; }
    renderCSVPreview();
  };
  reader.readAsText(file, 'UTF-8');
}

function renderCSVPreview() {
  $('dropZone').classList.add('hidden');
  $('csvPreview').classList.remove('hidden');
  $('batchResult').classList.add('hidden');

  const valid = csvRows.filter(r => !r._errors.length).length;
  const errs  = csvRows.length - valid;
  $('validCount').textContent = `${valid} 有效`;
  const eb = $('errorCount');
  eb.textContent = `${errs} 錯誤`;
  eb.classList.toggle('hidden', errs === 0);

  const table = document.createElement('table');
  table.className = 'csv-table';
  table.innerHTML = `<thead><tr><th>行</th><th>Email</th><th>姓名</th><th>標籤</th><th>Role</th><th>Action</th><th>狀態</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const row of csvRows) {
    const hasErr = row._errors.length > 0;
    const tr = document.createElement('tr');
    tr.className = hasErr ? 'row-error' : '';

    // Enrich with contact info (name + labels) from contactsMap
    const entry   = contactsMap[row.email];
    const cName   = !entry ? '' : (typeof entry === 'string' ? entry : (entry.name || ''));
    const cLabels = !entry ? [] : (typeof entry === 'object' ? (entry.labels || []) : []);
    const labelsHtml = cLabels.map(l => `<span class="label-chip" style="font-size:9px;padding:1px 4px">${escHtml(l)}</span>`).join(' ');

    tr.innerHTML = `
      <td>${row._line}</td>
      <td>${escHtml(row.email)}</td>
      <td style="font-size:11px;color:#CBD5E1">${escHtml(cName)}</td>
      <td>${labelsHtml || '<span style="color:#475569;font-size:10px">—</span>'}</td>
      <td>${escHtml(row.role)}</td>
      <td><span class="action-${row.action}">${ACTION_LABELS[row.action]||row.action}</span></td>
      <td>${hasErr
        ? `<span class="error-msg">${escHtml(row._errors.join('；'))}</span>`
        : '<span style="color:#4ADE80">✓</span>'}
      </td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  $('csvTableWrap').innerHTML = '';
  $('csvTableWrap').appendChild(table);
  $('applyCsvBtn').disabled = !csvRows.filter(r => !r._errors.length).length;
}

// Apply batch results locally to allPermissions — avoids a full re-scan.
// For each succeeded row: remove → filter out; add → push; update → patch role.
function applyBatchResultsLocally(rows, results) {
  for (const result of results) {
    if (result.status !== 'success') continue;
    const srcRow = rows.find(r => r.email === result.email && r.action === result.action);
    if (!srcRow) continue;

    if (result.action === 'remove') {
      allPermissions = allPermissions.filter(p => p.email !== result.email);

    } else if (result.action === 'add') {
      if (!allPermissions.some(p => p.email === result.email)) {
        const newPerm = { email: result.email, name: result.email, role: srcRow.role, labels: [], joinDate: '' };
        const entry = contactsMap[result.email];
        if (entry) {
          if (typeof entry === 'string') { newPerm.name = entry; }
          else { newPerm.name = entry.name || newPerm.name; newPerm.labels = entry.labels || []; newPerm.joinDate = entry.joinDate || ''; }
        }
        allPermissions.push(newPerm);
      }

    } else if (result.action === 'update') {
      const idx = allPermissions.findIndex(p => p.email === result.email);
      if (idx !== -1) allPermissions[idx].role = srcRow.role;
    }
  }
}

async function applyCSV() {
  const validRows = csvRows.filter(r => !r._errors.length);
  if (!validRows.length) return;
  $('applyCsvBtn').disabled = true;
  $('applyCsvBtn').textContent = '執行中…';
  showToast(`正在批次處理 ${validRows.length} 筆…`, 'info', 60000);
  try {
    const res = await sendMsg({ action: 'batchProcess', rows: validRows, currentCount: allPermissions.length });
    if (!res) throw new Error('無法連線至分頁');
    if (!res.success && res.reason) throw new Error(res.reason);
    const results = Array.isArray(res) ? res : (res.results || []);
    renderBatchResult(results);
    // Local update — no re-scan needed
    applyBatchResultsLocally(validRows, results);
    updateUserCount();
    renderUsers($('searchInput').value.trim());
  } catch (e) {
    showToast(`批次失敗：${e.message}`, 'error');
    $('applyCsvBtn').disabled = false;
    $('applyCsvBtn').textContent = '套用變更';
  }
}

function renderBatchResult(results) {
  $('csvPreview').classList.add('hidden');
  $('batchResult').classList.remove('hidden');
  const ok      = results.filter(r => r.status==='success').length;
  const err     = results.filter(r => r.status==='error').length;
  const skipped = results.filter(r => r.status==='skipped').length;

  if (skipped) {
    // Hit the 300-person cap — surface a prominent warning with the count.
    showToast(`已達分享上限 300 人：成功 ${ok}、失敗 ${err}、未加入 ${skipped}（見下方明細）`, 'error', 8000);
  } else {
    showToast(`完成：${ok} 成功，${err} 失敗`, err ? 'info' : 'success', 4000);
  }

  // Sort skipped rows to the top so the un-added list is easy to read off.
  const ordered = [...results].sort((a, b) =>
    (a.status==='skipped'?0:1) - (b.status==='skipped'?0:1) || a.line - b.line);

  const table = document.createElement('table');
  table.className = 'csv-table';
  table.innerHTML = `<thead><tr><th>行</th><th>Email</th><th>操作</th><th>結果</th></tr></thead>`;
  const tbody = document.createElement('tbody');
  for (const r of ordered) {
    const tr = document.createElement('tr');
    tr.className = r.status==='error' ? 'row-error'
                : r.status==='skipped' ? 'row-skipped'
                : 'row-success';
    let resultCell;
    if (r.status==='success')      resultCell = '<span style="color:#4ADE80">✓ 成功</span>';
    else if (r.status==='skipped') resultCell = `<span style="color:#FBBF24">⊘ 未加入（${escHtml(r.message||'已達上限')}）</span>`;
    else                           resultCell = `<span class="error-msg">${escHtml(r.message)}</span>`;
    tr.innerHTML = `
      <td>${r.line}</td>
      <td>${escHtml(r.email)}</td>
      <td><span class="action-${r.action}">${ACTION_LABELS[r.action]||r.action}</span></td>
      <td>${resultCell}</td>`;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  $('resultTableWrap').innerHTML = '';
  $('resultTableWrap').appendChild(table);
}

function resetCSV() {
  csvRows = [];
  $('dropZone').classList.remove('hidden');
  $('csvPreview').classList.add('hidden');
  $('batchResult').classList.add('hidden');
  $('csvFileInput').value = '';
}

// ── Sync sharing list by contact labels ──────────────────────────────────────
// Rule 1: label = "0待刪除名單" + IS  in sharing → remove
// Rule 2: label ≠ "0待刪除名單" (has any label) + NOT in sharing → add as reader
//         (NotebookLM sends the invite email automatically when adding)
// Rule 3: anything else (already sharing, or no label) → no change
function syncSharingByLabels() {
  if (!Object.keys(contactsMap).length) {
    showToast('請先載入聯絡人 CSV', 'error'); return;
  }
  if (!allPermissions.length) {
    showToast('請先切換到「分享用戶」tab 載入清單後再試', 'error'); return;
  }

  const DELETE_LABEL = '0待刪除名單';
  const sharingSet   = new Set(allPermissions.map(p => p.email));
  const rows = [];
  let lineNum = 1;

  for (const [email, entry] of Object.entries(contactsMap)) {
    const labels = typeof entry === 'object' ? (entry.labels || []) : [];

    if (labels.includes(DELETE_LABEL)) {
      // Rule 1: deletion label + currently sharing → remove
      if (sharingSet.has(email)) {
        rows.push({ _line: lineNum++, email, role: '', action: 'remove', _errors: [] });
      }
      // deletion label + NOT sharing → skip (nothing to do)

    } else if (labels.length > 0 && !sharingSet.has(email)) {
      // Rule 2: has other label(s) + not yet sharing → add as reader
      rows.push({ _line: lineNum++, email, role: 'reader', action: 'add', _errors: [] });

    }
    // Rule 3: already sharing with other labels, or no labels → no change
  }

  if (!rows.length) {
    showToast('沒有需要同步的項目', 'info'); return;
  }

  const removeCount = rows.filter(r => r.action === 'remove').length;
  const addCount    = rows.filter(r => r.action === 'add').length;
  showToast(`預覽：移除 ${removeCount} 人，新增 ${addCount} 人（含邀請通知）`, 'info', 4000);

  // Feed into batch preview (reuses existing batch infrastructure)
  csvRows = rows;
  switchTab('import');
  renderCSVPreview();
}

// ── Export shared users as CSV ────────────────────────────────────────────────
function exportUsersCSV() {
  const nonOwners = allPermissions.filter(p => p.role !== 'owner');
  if (!nonOwners.length) { showToast('沒有可匯出的分享用戶', 'error'); return; }
  const lines = ['email,role,action'];
  for (const p of nonOwners) lines.push(`${p.email},${p.role},update`);
  const csv = '﻿' + lines.join('\r\n'); // BOM for Excel UTF-8 compatibility
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const date = new Date().toISOString().slice(0, 10);
  Object.assign(document.createElement('a'), {
    href: url, download: `notebooklm_shares_${date}.csv`,
  }).click();
  URL.revokeObjectURL(url);
  showToast(`已匯出 ${nonOwners.length} 筆`, 'success');
}

// ── Contacts: load / enrich / parse ──────────────────────────────────────────

function loadContactsFromStorage() {
  return new Promise(resolve => {
    chrome.storage.local.get('contactsMap', data => {
      if (data.contactsMap && typeof data.contactsMap === 'object') {
        contactsMap = data.contactsMap;
        updateContactsStatus();
      }
      resolve();
    });
  });
}

// Overwrite perm.name / perm.labels / perm.joinDate with data from contactsMap.
// contactsMap values may be:
//   string  → old format (name only)
//   object  → { name, labels: string[], joinDate?: string }
function enrichWithContacts() {
  if (!Object.keys(contactsMap).length) return;
  for (const p of allPermissions) {
    const entry = contactsMap[p.email];
    if (!entry) continue;
    if (typeof entry === 'string') {
      p.name     = entry;
      p.labels   = [];
      p.joinDate = '';
    } else {
      p.name     = entry.name     || p.name;
      p.labels   = entry.labels   || [];
      p.joinDate = entry.joinDate || '';
    }
  }
}

function updateContactsStatus() {
  const count = Object.keys(contactsMap).length;
  const el = $('contactsStatus');
  if (!el) return;
  if (count > 0) {
    el.textContent = `✓ 已載入 ${count} 筆聯絡人`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

function processContactsText(text) {
  const map = parseContactsCSV(text);
  if (!map) {
    showToast('格式錯誤：找不到必要欄位（Name / First Name / E-mail 1 - Value）', 'error', 5000);
    return;
  }
  const count = Object.keys(map).length;
  if (!count) { showToast('未找到有效聯絡人資料（email 欄位為空？）', 'error', 5000); return; }
  contactsMap = map;
  chrome.storage.local.set({ contactsMap: map });
  updateContactsStatus();
  showToast(`已載入 ${count} 筆聯絡人`, 'success');
  enrichWithContacts();
  renderUsers($('searchInput').value.trim());
}

function handleContactsFile(file) {
  if (!file) return;

  const name = file.name.toLowerCase();
  const isXlsx = name.endsWith('.xlsx') || name.endsWith('.xls') ||
                 file.type.includes('spreadsheetml') || file.type.includes('ms-excel');

  if (isXlsx) {
    // ── Excel file: use SheetJS (xlsx.mini.min.js) to convert to CSV first ──
    if (typeof XLSX === 'undefined') {
      showToast('xlsx 解析器未載入，請重新整理頁面後再試', 'error', 5000); return;
    }
    showToast('正在解析 Excel 聯絡人資料…', 'info', 5000);
    const reader = new FileReader();
    reader.onerror = () => showToast('檔案讀取失敗，請確認檔案未損毀', 'error');
    reader.onload = e => {
      try {
        const wb  = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws  = wb.Sheets[wb.SheetNames[0]];
        const csv = XLSX.utils.sheet_to_csv(ws);
        processContactsText(csv);
      } catch (err) {
        showToast('xlsx 解析失敗：' + err.message, 'error', 5000);
      }
    };
    reader.readAsArrayBuffer(file);
  } else {
    // ── Plain CSV file ────────────────────────────────────────────────────────
    showToast('正在解析聯絡人 CSV…', 'info', 5000);
    const reader = new FileReader();
    reader.onerror = () => showToast('檔案讀取失敗，請確認檔案未損毀', 'error');
    reader.onload = e => processContactsText(e.target.result);
    reader.readAsText(file, 'UTF-8');
  }
}

// Parse Google Contacts export CSV → { 'email': { name, labels } }
//
// Supports two export layouts:
//   A) Standard Google export — single "Name" column + "Group Membership" column
//      Labels cell: "* myContacts ::: 聯成_三民 ::: 聯成_三重"
//   B) Custom/newer export — "First Name" + "Last Name" + "Labels" column
//      Labels cell: "聯成_忠孝"  (single value or ":::" separated)
//
// In both cases entries starting with '*' are system groups and are filtered out.
function parseContactsCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length < 2) return null;

  const header = parseCSVRow(lines[0].replace(/^﻿/, '')).map(h => h.trim().toLowerCase());

  // ── Name columns ──
  const nameIdx      = header.indexOf('name');         // Layout A
  const firstNameIdx = header.indexOf('first name');   // Layout B
  const lastNameIdx  = header.indexOf('last name');
  const nicknameIdx  = header.indexOf('nickname');

  // Need at least one name source
  if (nameIdx === -1 && firstNameIdx === -1 && lastNameIdx === -1 && nicknameIdx === -1) return null;

  // ── Email columns: "e-mail N - value" ──
  // We collect ALL matching columns but only USE the first one (primary email).
  // Using secondary emails (E-mail 2, E-mail 3…) would cause every alternate
  // address of a contact to inherit the same labels and be added to the
  // sharing list by syncSharingByLabels, which is unintended.
  const emailIdxs = header.reduce((acc, h, i) => {
    if (/^e-mail \d+ - value$/.test(h)) acc.push(i);
    return acc;
  }, []);
  if (!emailIdxs.length) return null;
  // Primary email index only (lowest column number = E-mail 1 - Value)
  const primaryEmailIdxs = [emailIdxs[0]];

  // ── Labels columns ──
  const groupMembershipIdx = header.indexOf('group membership'); // Layout A
  const labelsIdx          = header.indexOf('labels');           // Layout B

  // ── Join date column (optional) ──
  const joinDateIdx = header.indexOf('到職日期');

  const map = {};
  for (let r = 1; r < lines.length; r++) {
    const line = lines[r].trim();
    if (!line) continue;
    const cols = parseCSVRow(line);

    // Compose name
    let name = '';
    if (nameIdx !== -1) {
      name = cols[nameIdx]?.trim() || '';
    }
    if (!name && (firstNameIdx !== -1 || lastNameIdx !== -1)) {
      const last  = (lastNameIdx  !== -1 ? cols[lastNameIdx]?.trim()  : '') || '';
      const first = (firstNameIdx !== -1 ? cols[firstNameIdx]?.trim() : '') || '';
      // Chinese convention: surname first; works for Western names too
      name = (last + first).trim() || (first + last).trim();
    }
    if (!name && nicknameIdx !== -1) {
      name = cols[nicknameIdx]?.trim() || '';
    }
    if (!name) continue;

    // Collect user-created labels (filter out system groups starting with '*')
    const labelColIdx = groupMembershipIdx !== -1 ? groupMembershipIdx : labelsIdx;
    const rawLabels = (labelColIdx !== -1 ? cols[labelColIdx] : '') || '';
    const labels = rawLabels
      .split(':::')
      .map(g => g.trim())
      .filter(g => g && !g.startsWith('*'));

    // Join date
    const joinDate = (joinDateIdx !== -1 ? cols[joinDateIdx]?.trim() : '') || '';

    // Only store primary email — secondary emails must not be added to sharing
    for (const ei of primaryEmailIdxs) {
      const email = cols[ei]?.trim().toLowerCase();
      if (email && isValidEmail(email)) map[email] = { name, labels, joinDate };
    }
  }
  return map;
}

// RFC 4180-compliant CSV row parser (handles quoted fields with commas and escaped quotes)
function parseCSVRow(line) {
  const fields = [];
  let i = 0;
  while (i < line.length) {              // FIXED: < not <=  (was infinite-looping)
    if (line[i] === '"') {
      i++;
      let field = '';
      while (i < line.length) {
        if (line[i] === '"' && line[i + 1] === '"') { field += '"'; i += 2; }
        else if (line[i] === '"') { i++; break; }
        else { field += line[i++]; }
      }
      fields.push(field);
      if (line[i] === ',') i++;
    } else {
      const start = i;
      while (i < line.length && line[i] !== ',') i++;
      fields.push(line.slice(start, i));
      if (i < line.length) i++;          // advance past comma
    }
  }
  // Preserve trailing empty field when line ends with ','
  if (line.endsWith(',')) fields.push('');
  return fields;
}

function downloadTemplate() {
  const csv = [
    'email,role,action',
    '# role: reader / commenter / writer',
    '# action: add / update / remove',
    'alice@example.com,reader,add',
    'bob@example.com,writer,update',
    'charlie@example.com,,remove',
  ].join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿'+csv], {type:'text/csv;charset=utf-8'}));
  Object.assign(document.createElement('a'), {href:url, download:'notebooklm_share_template.csv'}).click();
  URL.revokeObjectURL(url);
}

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab===name));
  $('tabUsers').classList.toggle('hidden', name!=='users');
  $('tabImport').classList.toggle('hidden', name!=='import');
}

// ── Event listeners ───────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  $('closeBtn').addEventListener('click', () => {
    window.parent.postMessage('nlm-sm-close', '*');
  });

  $('refreshBtn').addEventListener('click', async () => {
    $('refreshBtn').classList.add('spinning');
    try { await loadUsers(); showToast('已重新整理', 'info', 1500); }
    finally { $('refreshBtn').classList.remove('spinning'); }
  });

  // 外層浮動視窗標題列的「⟳」透過 postMessage 觸發重新整理
  window.addEventListener('message', e => {
    if (e.data === 'nlm-sm-refresh') $('refreshBtn').click();
  });

  $('retryBtn').addEventListener('click', () => {
    $('errorState').classList.add('hidden');
    init();
  });

  document.querySelectorAll('.tab').forEach(t =>
    t.addEventListener('click', () => switchTab(t.dataset.tab))
  );

  $('addUserBtn').addEventListener('click', showAddForm);
  $('cancelAddBtn').addEventListener('click', hideAddForm);
  $('confirmAddBtn').addEventListener('click', confirmAdd);
  $('newEmail').addEventListener('keydown', e => { if (e.key==='Enter') confirmAdd(); });
  $('searchInput').addEventListener('input', onSearch);
  $('clearSearch').addEventListener('click', () => {
    $('searchInput').value = '';
    $('clearSearch').classList.add('hidden');
    renderUsers('');
  });

  const drop = $('dropZone'), fi = $('csvFileInput');
  $('browseBtn').addEventListener('click', () => fi.click());
  fi.addEventListener('change', () => handleCSVFile(fi.files[0]));
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault(); drop.classList.remove('drag-over');
    handleCSVFile(e.dataTransfer.files[0]);
  });
  $('cancelCsvBtn').addEventListener('click', resetCSV);
  $('closeBatchBtn').addEventListener('click', resetCSV);
  $('applyCsvBtn').addEventListener('click', applyCSV);
  $('downloadTemplateBtn').addEventListener('click', downloadTemplate);

  $('exportBtn').addEventListener('click', exportUsersCSV);
  $('syncByLabelBtn').addEventListener('click', syncSharingByLabels);

  const cd = $('contactsDropZone'), ci = $('contactsCsvInput');
  $('browseContactsBtn').addEventListener('click', () => ci.click());
  ci.addEventListener('change', () => { handleContactsFile(ci.files[0]); ci.value = ''; });
  cd.addEventListener('dragover', e => { e.preventDefault(); cd.classList.add('drag-over'); });
  cd.addEventListener('dragleave', () => cd.classList.remove('drag-over'));
  cd.addEventListener('drop', e => {
    e.preventDefault(); cd.classList.remove('drag-over');
    handleContactsFile(e.dataTransfer.files[0]);
  });

  init();
});
