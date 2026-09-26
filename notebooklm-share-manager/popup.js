// ── State ─────────────────────────────────────────────────────────────────────
let currentFileId = null;
let allPermissions = [];
let csvRows = [];

const ROLE_LABELS = {
  owner:     '擁有者',
  writer:    '編輯者',
  commenter: '留言者',
  reader:    '檢視者',
};
const ROLE_BADGE = {
  owner:     'badge-owner',
  writer:    'badge-writer',
  commenter: 'badge-commenter',
  reader:    'badge-reader',
};
const ACTION_LABELS = { add: '新增', update: '更新', remove: '移除' };

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
  return new Promise((resolve) => chrome.runtime.sendMessage(data, resolve));
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function avatarText(name, email) {
  if (name && name !== email) return name.trim()[0];
  return (email || '?')[0];
}

function getAvatarColor(str) {
  const colors = ['#4F86F7','#7C3AED','#059669','#DC2626','#D97706','#0891B2'];
  let h = 0;
  for (const c of str) h = (h * 31 + c.charCodeAt(0)) & 0xFFFFFF;
  return colors[Math.abs(h) % colors.length];
}

// ── Drive API wrappers ────────────────────────────────────────────────────────

async function apiCall(data) {
  const res = await sendMsg(data);
  if (!res) throw new Error('擴充程式無法連線，請重新整理頁面');
  if (res.error) throw Object.assign(new Error(res.error), { status: res.status });
  return res;
}

// ── Init ──────────────────────────────────────────────────────────────────────

async function init() {
  // Try to find active NotebookLM tab
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !/^https:\/\/notebook(lm)?\.google\.com\/notebook\//.test(tab.url || '')) {
    $('notOnPage').classList.remove('hidden');
    return;
  }

  const match = tab.url.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
  if (!match) {
    $('notOnPage').classList.remove('hidden');
    return;
  }

  currentFileId = match[1];
  $('mainContent').classList.remove('hidden');

  // Load notebook name
  try {
    const info = await apiCall({ action: 'getFileInfo', fileId: currentFileId });
    $('notebookName').textContent = info.name || currentFileId;
  } catch {
    $('notebookName').textContent = currentFileId;
  }

  await loadUsers();
}

// ── Users ─────────────────────────────────────────────────────────────────────

async function loadUsers() {
  const list = $('usersList');
  list.innerHTML = `<div class="loading-row"><div class="spinner"></div><span>載入中…</span></div>`;
  $('noUsers').classList.add('hidden');
  $('noResults').classList.add('hidden');

  try {
    const data = await apiCall({ action: 'listPermissions', fileId: currentFileId });
    allPermissions = (data.permissions || []).filter(p => !p.deleted);
    renderUsers($('searchInput').value.trim());
  } catch (e) {
    list.innerHTML = `<div class="loading-row" style="color:#EF4444">載入失敗：${e.message}</div>`;
  }
}

function renderUsers(filter = '') {
  const list = $('usersList');
  const q = filter.toLowerCase();
  const filtered = allPermissions.filter(p =>
    !q ||
    p.emailAddress?.toLowerCase().includes(q) ||
    p.displayName?.toLowerCase().includes(q)
  );

  list.innerHTML = '';

  if (allPermissions.length === 0) {
    $('noUsers').classList.remove('hidden');
    return;
  }
  $('noUsers').classList.add('hidden');

  if (filtered.length === 0) {
    $('noResults').classList.remove('hidden');
    return;
  }
  $('noResults').classList.add('hidden');

  for (const perm of filtered) {
    list.appendChild(buildUserRow(perm));
  }
}

function buildUserRow(perm) {
  const row = document.createElement('div');
  row.className = 'user-row';
  row.dataset.permId = perm.id;

  const initials = avatarText(perm.displayName, perm.emailAddress);
  const color = getAvatarColor(perm.emailAddress || perm.id);
  const isOwner = perm.role === 'owner';
  const name = perm.displayName || perm.emailAddress || '未知用戶';

  row.innerHTML = `
    <div class="avatar" style="background:${color}">
      ${perm.photoLink
        ? `<img src="${perm.photoLink}" alt="${initials}" onerror="this.parentNode.innerHTML='${initials}'">`
        : initials}
    </div>
    <div class="user-info">
      <div class="user-name">${escHtml(name)}</div>
      ${perm.emailAddress && perm.emailAddress !== name
        ? `<div class="user-email">${escHtml(perm.emailAddress)}</div>`
        : ''}
    </div>
    <div class="user-role">
      <span class="badge ${ROLE_BADGE[perm.role] || 'badge-reader'}">${ROLE_LABELS[perm.role] || perm.role}</span>
    </div>
    <div class="user-actions">
      ${isOwner ? '' : `
        <button class="btn-icon edit-btn" title="修改權限">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
          </svg>
        </button>
        <button class="btn-icon danger delete-btn" title="移除分享">
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
            <path d="M10 11v6M14 11v6"/>
            <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>
          </svg>
        </button>
      `}
    </div>
  `;

  if (!isOwner) {
    row.querySelector('.edit-btn').addEventListener('click', () => enterEditMode(row, perm));
    row.querySelector('.delete-btn').addEventListener('click', () => deleteUser(perm));
  }
  return row;
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function enterEditMode(row, perm) {
  // Cancel any other edit in progress
  document.querySelectorAll('.user-row.editing').forEach(r => {
    if (r !== row) exitEditMode(r);
  });

  row.classList.add('editing');
  const roleDiv = row.querySelector('.user-role');
  const actDiv  = row.querySelector('.user-actions');

  roleDiv.innerHTML = `
    <select class="role-select-inline">
      <option value="reader"    ${perm.role==='reader'    ?'selected':''}>檢視者</option>
      <option value="commenter" ${perm.role==='commenter' ?'selected':''}>留言者</option>
      <option value="writer"    ${perm.role==='writer'    ?'selected':''}>編輯者</option>
    </select>
  `;
  actDiv.innerHTML = `
    <button class="btn-icon success save-btn" title="儲存">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <polyline points="20 6 9 17 4 12"/>
      </svg>
    </button>
    <button class="btn-icon cancel-edit-btn" title="取消">
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
        <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
      </svg>
    </button>
  `;

  actDiv.querySelector('.save-btn').addEventListener('click', async () => {
    const newRole = roleDiv.querySelector('.role-select-inline').value;
    if (newRole === perm.role) { exitEditMode(row); return; }
    actDiv.querySelector('.save-btn').disabled = true;
    try {
      await apiCall({ action: 'updatePermission', fileId: currentFileId, permissionId: perm.id, data: { role: newRole } });
      showToast(`已更新 ${perm.emailAddress || perm.displayName} 的權限`, 'success');
      await loadUsers();
    } catch (e) {
      showToast(`更新失敗：${e.message}`, 'error');
      exitEditMode(row);
    }
  });

  actDiv.querySelector('.cancel-edit-btn').addEventListener('click', () => exitEditMode(row));
}

function exitEditMode(row) {
  const perm = allPermissions.find(p => p.id === row.dataset.permId);
  if (perm) {
    const newRow = buildUserRow(perm);
    row.replaceWith(newRow);
  }
}

async function deleteUser(perm) {
  const name = perm.displayName || perm.emailAddress || '此用戶';
  if (!confirm(`確定要移除「${name}」的分享權限嗎？`)) return;
  try {
    await apiCall({ action: 'deletePermission', fileId: currentFileId, permissionId: perm.id });
    showToast(`已移除 ${name}`, 'success');
    await loadUsers();
  } catch (e) {
    showToast(`移除失敗：${e.message}`, 'error');
  }
}

// ── Add user form ─────────────────────────────────────────────────────────────

function showAddForm() {
  $('addUserForm').classList.remove('hidden');
  $('addUserBtn').classList.add('hidden');
  $('newEmail').value = '';
  $('newRole').value = 'reader';
  $('emailError').classList.add('hidden');
  $('newEmail').classList.remove('error');
  $('newEmail').focus();
}

function hideAddForm() {
  $('addUserForm').classList.add('hidden');
  $('addUserBtn').classList.remove('hidden');
}

async function confirmAdd() {
  const email = $('newEmail').value.trim();
  const role  = $('newRole').value;

  $('emailError').classList.add('hidden');
  $('newEmail').classList.remove('error');

  if (!email) {
    showFieldError('請輸入電子郵件');
    return;
  }
  if (!isValidEmail(email)) {
    showFieldError('電子郵件格式不正確');
    return;
  }
  if (allPermissions.some(p => p.emailAddress?.toLowerCase() === email.toLowerCase())) {
    showFieldError('此用戶已在分享清單中');
    return;
  }

  $('confirmAddBtn').disabled = true;
  $('confirmAddBtn').textContent = '新增中…';
  try {
    await apiCall({ action: 'addPermission', fileId: currentFileId, data: { email, role } });
    showToast(`已新增 ${email}（通知信已發送）`, 'success');
    hideAddForm();
    await loadUsers();
  } catch (e) {
    showToast(`新增失敗：${e.message}`, 'error');
  } finally {
    $('confirmAddBtn').disabled = false;
    $('confirmAddBtn').textContent = '新增用戶';
  }
}

function showFieldError(msg) {
  const el = $('emailError');
  el.textContent = msg;
  el.classList.remove('hidden');
  $('newEmail').classList.add('error');
  $('newEmail').focus();
}

// ── Search ────────────────────────────────────────────────────────────────────

function onSearch() {
  const q = $('searchInput').value.trim();
  $('clearSearch').classList.toggle('hidden', q === '');
  renderUsers(q);
}

// ── CSV ───────────────────────────────────────────────────────────────────────

const VALID_ROLES   = new Set(['reader', 'commenter', 'writer']);
const VALID_ACTIONS = new Set(['add', 'update', 'remove']);

function parseCSV(text) {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const rows = [];
  let lineNum = 0;

  for (const raw of lines) {
    lineNum++;
    const line = raw.trim();
    if (!line) continue;

    // Skip header row
    if (lineNum === 1 && /^email/i.test(line)) continue;

    const parts = line.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''));
    const [email = '', role = '', action = ''] = parts;
    const errors = [];

    if (!email) errors.push('缺少 email');
    else if (!isValidEmail(email)) errors.push('email 格式錯誤');

    const actionLower = action.toLowerCase();
    if (!VALID_ACTIONS.has(actionLower)) errors.push(`action 無效（${action || '空白'}）`);

    const roleLower = role.toLowerCase();
    if (actionLower !== 'remove') {
      if (!VALID_ROLES.has(roleLower)) errors.push(`role 無效（${role || '空白'}）`);
    }

    rows.push({
      _line: lineNum,
      email: email.toLowerCase(),
      role: roleLower,
      action: actionLower,
      _errors: errors,
    });
  }
  return rows;
}

function handleCSVFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    csvRows = parseCSV(e.target.result);
    if (csvRows.length === 0) {
      showToast('CSV 檔案沒有有效資料', 'error');
      return;
    }
    renderCSVPreview();
  };
  reader.readAsText(file, 'UTF-8');
}

function renderCSVPreview() {
  $('dropZone').classList.add('hidden');
  $('csvPreview').classList.remove('hidden');
  $('batchResult').classList.add('hidden');

  const valid = csvRows.filter(r => r._errors.length === 0).length;
  const errors = csvRows.length - valid;

  $('validCount').textContent = `${valid} 有效`;
  const errBadge = $('errorCount');
  errBadge.textContent = `${errors} 錯誤`;
  errBadge.classList.toggle('hidden', errors === 0);

  const table = document.createElement('table');
  table.className = 'csv-table';
  table.innerHTML = `<thead><tr>
    <th>行</th><th>Email</th><th>Role</th><th>Action</th><th>狀態</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');

  for (const row of csvRows) {
    const hasErr = row._errors.length > 0;
    const tr = document.createElement('tr');
    tr.className = hasErr ? 'row-error' : '';
    tr.innerHTML = `
      <td>${row._line}</td>
      <td>${escHtml(row.email)}</td>
      <td>${escHtml(row.role)}</td>
      <td><span class="action-${row.action}">${ACTION_LABELS[row.action] || row.action}</span></td>
      <td>${hasErr
        ? `<span class="error-msg">${row._errors.join('；')}</span>`
        : '<span style="color:#059669">✓</span>'}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const wrap = $('csvTableWrap');
  wrap.innerHTML = '';
  wrap.appendChild(table);

  const validRows = csvRows.filter(r => r._errors.length === 0);
  $('applyCsvBtn').disabled = validRows.length === 0;
}

async function applyCSV() {
  const validRows = csvRows.filter(r => r._errors.length === 0);
  if (validRows.length === 0) return;

  $('applyCsvBtn').disabled = true;
  $('applyCsvBtn').textContent = `執行中 (0/${validRows.length})…`;

  try {
    const results = await apiCall({ action: 'batchProcess', fileId: currentFileId, rows: validRows });
    renderBatchResult(results);
    await loadUsers();
  } catch (e) {
    showToast(`批次處理失敗：${e.message}`, 'error');
    $('applyCsvBtn').disabled = false;
    $('applyCsvBtn').textContent = '套用變更';
  }
}

function renderBatchResult(results) {
  $('csvPreview').classList.add('hidden');
  $('batchResult').classList.remove('hidden');

  const ok  = results.filter(r => r.status === 'success').length;
  const err = results.filter(r => r.status === 'error').length;
  showToast(`完成：${ok} 成功，${err} 失敗`, err > 0 ? 'info' : 'success', 4000);

  const table = document.createElement('table');
  table.className = 'csv-table';
  table.innerHTML = `<thead><tr>
    <th>行</th><th>Email</th><th>操作</th><th>結果</th>
  </tr></thead>`;
  const tbody = document.createElement('tbody');

  for (const r of results) {
    const isErr = r.status === 'error';
    const tr = document.createElement('tr');
    tr.className = isErr ? 'row-error' : 'row-success';
    tr.innerHTML = `
      <td>${r.line}</td>
      <td>${escHtml(r.email)}</td>
      <td><span class="action-${r.action}">${ACTION_LABELS[r.action] || r.action}</span></td>
      <td>${isErr
        ? `<span class="error-msg">${escHtml(r.message)}</span>`
        : '<span style="color:#059669">✓ 成功</span>'}</td>
    `;
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);

  const wrap = $('resultTableWrap');
  wrap.innerHTML = '';
  wrap.appendChild(table);
}

function resetCSVUI() {
  csvRows = [];
  $('dropZone').classList.remove('hidden');
  $('csvPreview').classList.add('hidden');
  $('batchResult').classList.add('hidden');
  $('csvFileInput').value = '';
}

// ── Template download ─────────────────────────────────────────────────────────

function downloadTemplate() {
  const csv = [
    'email,role,action',
    '# role: reader / commenter / writer',
    '# action: add / update / remove',
    'alice@example.com,reader,add',
    'bob@example.com,writer,update',
    'charlie@example.com,,remove',
  ].join('\r\n');

  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = 'notebooklm_share_template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

// ── Tab switching ─────────────────────────────────────────────────────────────

function switchTab(name) {
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === name);
  });
  $('tabUsers').classList.toggle('hidden', name !== 'users');
  $('tabImport').classList.toggle('hidden', name !== 'import');
}

// ── Refresh ───────────────────────────────────────────────────────────────────

async function refresh() {
  const btn = $('refreshBtn');
  btn.classList.add('spinning');
  try {
    await loadUsers();
    showToast('已重新整理', 'info', 1500);
  } finally {
    btn.classList.remove('spinning');
  }
}

// ── Listen for URL changes from content script ────────────────────────────────

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.action === 'urlChanged') {
    currentFileId = msg.notebookId;
    if (currentFileId) init();
  }
});

// ── Event listeners ───────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // Tabs
  document.querySelectorAll('.tab').forEach(t => {
    t.addEventListener('click', () => switchTab(t.dataset.tab));
  });

  // Users tab
  $('addUserBtn').addEventListener('click', showAddForm);
  $('cancelAddBtn').addEventListener('click', hideAddForm);
  $('confirmAddBtn').addEventListener('click', confirmAdd);
  $('newEmail').addEventListener('keydown', e => { if (e.key === 'Enter') confirmAdd(); });
  $('searchInput').addEventListener('input', onSearch);
  $('clearSearch').addEventListener('click', () => {
    $('searchInput').value = '';
    $('clearSearch').classList.add('hidden');
    renderUsers('');
  });
  $('refreshBtn').addEventListener('click', refresh);

  // CSV tab
  const dropZone = $('dropZone');
  const fileInput = $('csvFileInput');

  $('browseBtn').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => handleCSVFile(fileInput.files[0]));

  dropZone.addEventListener('dragover', e => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', e => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    handleCSVFile(e.dataTransfer.files[0]);
  });

  $('cancelCsvBtn').addEventListener('click', resetCSVUI);
  $('closeBatchBtn').addEventListener('click', resetCSVUI);
  $('applyCsvBtn').addEventListener('click', applyCSV);
  $('downloadTemplateBtn').addEventListener('click', downloadTemplate);

  // Init
  init();
});
