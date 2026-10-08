// ── Register this tab and keep service worker alive ───────────────────────────
function ping() {
  chrome.runtime.sendMessage({ action: 'ping' }, () => void chrome.runtime.lastError);
}
chrome.runtime.sendMessage({ action: 'registerTab' }, () => void chrome.runtime.lastError);
ping();
setInterval(ping, 20_000);

// ── Helpers ───────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

const EMAIL_RE  = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;        // exact match
const EMAIL_ANY = /[^\s@,;"'<>()\[\]]+@[^\s@,;"'<>()\[\]]+\.[^\s@,;"'<>()\[\].]{2,}/g; // anywhere in string

// Role text → internal value (Traditional Chinese + English)
const ROLE_MAP = {
  '擁有者': 'owner',  'Owner': 'owner',
  '編輯者': 'writer', 'Editor': 'writer',
  '留言者': 'commenter', 'Commenter': 'commenter',
  '檢視者': 'reader', 'Viewer': 'reader',
};

// Internal value → role text to select in dropdown
const ROLE_LABELS_ZH = { writer: '編輯者', commenter: '留言者', reader: '檢視者' };
const ROLE_LABELS_EN = { writer: 'Editor', commenter: 'Commenter', reader: 'Viewer' };

// ── Share button & dialog helpers ─────────────────────────────────────────────
function findShareButton() {
  // Strategy 1: aria-label attribute — try all common variants
  // Also check [role="button"] divs, not just <button> elements.
  // Explicitly exclude buttons that live inside a dialog (would be a "Share" action
  // inside the sharing dialog itself, not the main page button).
  const ariaSelectors = [
    'button[aria-label*="共用"]',
    'button[aria-label*="Share"]',
    'button[aria-label*="share"]',
    'button[aria-label*="分享"]',
    '[role="button"][aria-label*="共用"]',
    '[role="button"][aria-label*="Share"]',
    '[role="button"][aria-label*="share"]',
    '[role="button"][aria-label*="分享"]',
  ];
  for (const sel of ariaSelectors) {
    for (const el of document.querySelectorAll(sel)) {
      if (!el.closest('[role="dialog"]')) return el;
    }
  }

  // Strategy 2: text-content matching (handles buttons without aria-label)
  for (const btn of document.querySelectorAll('button, [role="button"]')) {
    if (btn.closest('[role="dialog"]')) continue;
    const text = btn.textContent.trim();
    // Exact or near-exact match first (most reliable)
    if (text === '共用' || text === '分享' || text === 'Share') return btn;
    if (text.endsWith(' 共用') || text.startsWith('共用 ')) return btn;
    if (text.endsWith(' 分享') || text.startsWith('分享 ')) return btn;
  }

  return null;
}

function findDialogCloseButton() {
  const dialog = findOpenSharingDialog();
  if (!dialog) return null;
  for (const sel of [
    'button[aria-label*="關閉"]',
    'button[aria-label*="Close"]',
    'button[aria-label*="close"]',
    'button[data-mdc-dialog-action]',
  ]) {
    const el = dialog.querySelector(sel);
    if (el) return el;
  }
  return [...dialog.querySelectorAll('button')].find(b => /^[×✕X✖]$/.test(b.textContent.trim())) || null;
}

function isSharingDialog(dialog) {
  // Primary: role labels are unique to the sharing dialog.
  // Checking for these first avoids false-positives on "新增來源" or other dialogs
  // that happen to contain "共用" / "Share" text or generic "新增" inputs.
  const text = dialog.textContent;
  if (text.includes('擁有者') || text.includes('Owner') ||
      text.includes('編輯者') || text.includes('Editor') ||
      text.includes('留言者') || text.includes('Commenter') ||
      text.includes('檢視者') || text.includes('Viewer')) return true;

  // Secondary: "共用"/"Share" heading + a real email input (before users have loaded).
  // We intentionally do NOT match input[placeholder*="新增"] here because "新增來源"
  // and other dialogs also use "新增" in their placeholder text.
  if ((text.includes('共用') || text.includes('Share')) &&
      dialog.querySelector('input[type="email"]')) return true;

  return false;
}

// Scan ALL [role="dialog"] elements and return the first one that is the
// sharing dialog.  Using querySelectorAll (not querySelector) is essential
// because Google may render the autocomplete dropdown or other overlays as
// additional [role="dialog"] elements — querySelector would only return the
// first one in DOM order, which might NOT be the sharing dialog.
function findOpenSharingDialog() {
  for (const el of document.querySelectorAll('[role="dialog"]')) {
    if (isSharingDialog(el)) return el;
  }
  return null;
}

// Return a non-sharing modal that is visibly blocking the page, or null.
// We use three complementary checks so we catch every variant:
//   1. [role="dialog"][aria-modal="true"] — explicit ARIA modal
//   2. Angular CDK overlay backdrop-showing — present whenever a CDK dialog/sheet is
//      open; persistent side-panels (對話, 來源) never add a backdrop, so this only
//      fires for genuine blocking overlays like 新增來源
//   3. Any large visible [role="dialog"] that is not the sharing dialog
//      (fallback for dialogs that omit both aria-modal and CDK backdrop)
// All checks skip the sharing dialog via isSharingDialog().
function findBlockingModal() {
  // ── Check 1: explicit aria-modal="true" ──────────────────────────────────
  for (const el of document.querySelectorAll('[role="dialog"][aria-modal="true"]')) {
    if (isSharingDialog(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 200 && r.height > 100) return el;
  }

  // ── Check 2: Angular CDK overlay backdrop ────────────────────────────────
  // .cdk-overlay-backdrop-showing is added by @angular/cdk when a modal opens.
  // Persistent panels (對話, 來源) are side-drawers without backdrops.
  // We check this BEFORE opening our dialog, so the sharing dialog's own
  // backdrop (if any) is never in the DOM at this point.
  const backdrop = document.querySelector('.cdk-overlay-backdrop-showing');
  if (backdrop) {
    const r = backdrop.getBoundingClientRect();
    // Must cover a substantial portion of the viewport to rule out tiny overlays
    if (r.width > window.innerWidth * 0.4 && r.height > window.innerHeight * 0.4) {
      return backdrop;
    }
  }

  // ── Check 3: any large visible non-sharing [role="dialog"] ───────────────
  // Catches dialogs that omit aria-modal and don't use CDK backdrop.
  // Side-panels (對話, 來源) attach to the viewport edge (left < 100 or right > vw-100);
  // centred modals like 新增來源 do not — so we skip edge-attached elements.
  for (const el of document.querySelectorAll('[role="dialog"]')) {
    if (isSharingDialog(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 200 || r.height < 150) continue;
    const isEdgePanel = r.left < 100 || r.right > window.innerWidth - 100;
    if (isEdgePanel) continue;
    return el;
  }

  return null;
}

async function openDialog() {
  // If sharing dialog is already open (user may have opened it manually), use it
  const alreadyOpen = findOpenSharingDialog();
  if (alreadyOpen) return alreadyOpen;

  // If a TRUE modal dialog is open (aria-modal="true", e.g. 新增來源, 設定…),
  // do NOT disrupt the user — return null so the caller can show a friendly error.
  // Persistent panels (對話, 來源) have role="dialog" but no aria-modal, so they
  // are NOT treated as blocking and Share Manager works normally alongside them.
  if (findBlockingModal()) return null;

  // No blocking modal — open the sharing dialog via the share button.
  // Retry once after 2 s in case the page is still rendering (SPA hydration).
  let btn = findShareButton();
  if (!btn) {
    await sleep(2000);
    btn = findShareButton();
  }
  if (!btn) return null;
  btn.click();

  // Wait for the sharing dialog to appear
  const deadline = Date.now() + 6000;
  while (Date.now() < deadline) {
    const d = findOpenSharingDialog();
    if (d) return d;
    await sleep(200);
  }
  return null;
}

async function closeDialog() {
  const closeBtn = findDialogCloseButton();
  if (closeBtn) {
    closeBtn.click();
  } else {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  // Wait for the SHARING dialog to disappear (not just any role="dialog" element —
  // persistent panels like 對話 always have role="dialog" but are not modals)
  for (let i = 0; i < 10; i++) {
    await sleep(200);
    if (!findOpenSharingDialog()) break;
  }
}

async function waitForDialog(timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const d = findOpenSharingDialog();
    if (d) return d;
    await sleep(200);
  }
  return null;
}

// True if the autocomplete [role="listbox"] is currently rendered and visible.
// A listbox may stay in the DOM but become display:none / size-0 after dismissal.
function isListboxVisible() {
  const lb = document.querySelector('[role="listbox"]');
  if (!lb) return false;
  const r = lb.getBoundingClientRect();
  return r.width > 0 && r.height > 0;
}

// Dismiss the autocomplete dropdown (contact suggestions, NOT real shared users).
// Tries multiple strategies in sequence and returns as soon as the listbox is gone.
async function dismissAutocomplete(dialog) {
  if (!isListboxVisible()) return; // already gone

  const input = findEmailInput(dialog);

  // Strategy 1: blur the focused input
  if (input) {
    input.blur();
    await sleep(200);
    if (!isListboxVisible()) return;
  }

  // Strategy 2: Escape keydown on the currently-focused element
  // (first Escape on a combobox dismisses the listbox; second would close the dialog)
  const escTarget = (document.activeElement && document.activeElement !== document.body)
    ? document.activeElement : input;
  if (escTarget) {
    escTarget.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true,
    }));
    await sleep(250);
    if (!isListboxVisible()) return;
  }

  // Strategy 3: click on the dialog title area (top ~40 px) — a neutral target
  const r = dialog.getBoundingClientRect();
  if (r.width > 0) {
    for (const yOff of [14, 24, 36]) {
      const el = document.elementFromPoint(r.left + r.width / 2, r.top + yOff);
      if (el && el !== input && el !== document.body &&
          !el.closest('[role="listbox"]') && !el.matches('button[aria-label*="關閉"], button[aria-label*="Close"]')) {
        el.click();
        await sleep(250);
        if (!isListboxVisible()) return;
        break;
      }
    }
  }

  // Strategy 4: dispatch a synthetic mousedown on the dialog container
  dialog.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
  await sleep(200);
  if (!isListboxVisible()) return;

  // Strategy 5: Tab key (moves focus without closing the dialog)
  if (input) {
    input.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'Tab', code: 'Tab', keyCode: 9, bubbles: true, cancelable: true,
    }));
    await sleep(300);
  }
}

// Locate the "具有存取權的使用者" / "People with access" section.
// This section contains ONLY the already-shared users — not autocomplete suggestions.
// Searching document.body handles portal-rendered lists (outside [role="dialog"]).
function findPermissionSection() {
  const SECTION_HEADERS = [
    '具有存取權的使用者', '具有存取權',
    'People with access', 'Who has access',
  ];

  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (!SECTION_HEADERS.some(h => text.includes(h))) continue;

    // Found the section header text node.
    // Walk UP until we find an ancestor that contains role labels (actual user rows).
    let el = node.parentElement;
    let best = null;
    for (let i = 0; i < 12; i++) {
      if (!el || el === document.body) break;
      if (Object.keys(ROLE_MAP).some(r => el.textContent.includes(r))) {
        best = el; // keep walking up to capture the widest matching ancestor
      } else if (best) {
        break; // we've gone past the section
      }
      el = el.parentElement;
    }
    if (best) return best;
  }
  return null; // not found — caller falls back to document.body
}

// Wait for the actual permission list to be visible.
// Passes the dialog element so we can retry dismissAutocomplete if listbox re-appears.
// Periodically calls dismissAutocomplete until the listbox is gone, then checks for role labels.
async function waitForPermissionList(dialog, timeoutMs = 25000) {
  const ROLE_INDICATORS = ['擁有者', '編輯者', '留言者', '檢視者',
                           'Owner', 'Editor', 'Commenter', 'Viewer'];
  const deadline = Date.now() + timeoutMs;
  let lastDismiss = 0;

  while (Date.now() < deadline) {
    // Bail out if the sharing dialog was closed unexpectedly
    if (!findOpenSharingDialog()) { await sleep(300); continue; }

    // If autocomplete listbox is still visible, keep trying to dismiss it (every 1.5 s)
    if (isListboxVisible()) {
      const now = Date.now();
      if (now - lastDismiss > 1500) {
        lastDismiss = now;
        await dismissAutocomplete(dialog);
      } else {
        await sleep(300);
      }
      continue;
    }

    // Listbox is gone — check if permission list is now showing
    if (ROLE_INDICATORS.some(r => document.body.textContent.includes(r))) return true;
    await sleep(300);
  }
  return false;
}

// ── DOM scraping ──────────────────────────────────────────────────────────────

// Return all email addresses found anywhere inside el:
//   • text nodes (full match)
//   • element attributes: title, aria-label, data-email, data-value, data-hovercard-id
//   • element.textContent (catches truncated text where the full email is in a wrapper)
function scrapeEmails(el) {
  const found = new Map(); // lowercase email → {text, node (element or text node)}

  function addEmail(email, ref) {
    const key = email.toLowerCase();
    if (!found.has(key)) found.set(key, { text: email, node: ref });
  }

  // 1. Text nodes
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    if (EMAIL_RE.test(text)) {
      addEmail(text, node);
    } else {
      // Might contain an email embedded in longer text
      const matches = text.match(EMAIL_ANY);
      if (matches) matches.forEach(m => addEmail(m, node));
    }
  }

  // 2. Attributes on every element inside the dialog
  const ATTRS = ['title', 'aria-label', 'data-email', 'data-value',
                 'data-hovercard-id', 'data-name', 'data-address'];
  for (const elem of el.querySelectorAll('*')) {
    for (const attr of ATTRS) {
      const val = elem.getAttribute(attr);
      if (!val) continue;
      if (EMAIL_RE.test(val.trim())) {
        addEmail(val.trim(), elem);
      } else {
        const matches = val.match(EMAIL_ANY);
        if (matches) matches.forEach(m => addEmail(m, elem));
      }
    }
  }

  return [...found.values()];
}

// Find the ancestor that most likely represents a single user row.
// Works whether emailRef is a text node or an element node.
function findRowContainer(emailRef) {
  // Normalise: get an Element to start from
  let el = (emailRef.nodeType === Node.TEXT_NODE)
    ? emailRef.parentElement
    : emailRef;

  for (let i = 0; i < 8; i++) {
    if (!el || el.matches('[role="dialog"]') || el.tagName === 'BODY') break;
    const parent = el.parentElement;
    if (!parent || parent.matches('[role="dialog"]')) return el;
    // Count emails in parent — if parent has more than one email, el is the row
    if (scrapeEmails(parent).length > 1) return el;
    el = parent;
  }
  return el;
}

// Determine role from a row element's text content
function detectRole(rowEl) {
  const text = rowEl.textContent;
  for (const [label, role] of Object.entries(ROLE_MAP)) {
    if (text.includes(label)) return role;
  }
  return 'reader'; // default
}

// Determine display name from a row element
function detectName(rowEl, email) {
  const walker = document.createTreeWalker(rowEl, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const t = node.textContent.trim();
    if (!t || t === email) continue;
    if (EMAIL_RE.test(t)) continue;
    // Skip role labels
    if (Object.keys(ROLE_MAP).some(l => t === l)) continue;
    if (t.length > 1) return t;
  }
  return email;
}

// Parse user list from the given root element.
// Pass in the result of findPermissionSection() (or document.body as fallback)
// so we only scrape the actual shared-users section, not autocomplete suggestions.
// Strategy A (primary): find role-label text nodes → locate their row → find email in that row.
// Strategy B (fallback): find email addresses → detect role from containing row.
function scrapeUsers(searchRoot) {
  const users = [];
  const seen = new Set();

  // ── Strategy A: role-label anchored ──
  const walker = document.createTreeWalker(searchRoot, NodeFilter.SHOW_TEXT);
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent.trim();
    const role = ROLE_MAP[text];
    if (!role) continue; // not a role label

    const row = findRowContainer(node);
    const rowEmails = scrapeEmails(row);
    for (const { text: email } of rowEmails) {
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const name = detectName(row, email);
      users.push({ email: key, name, role, _row: row });
    }
  }

  // ── Strategy B: email anchored (fallback if no role labels found) ──
  if (users.length === 0) {
    for (const { text: email, node: eNode } of scrapeEmails(searchRoot)) {
      const key = email.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      const row = findRowContainer(eNode);
      const role = detectRole(row);
      const name = detectName(row, email);
      users.push({ email: key, name, role, _row: row });
    }
  }

  return users;
}

// ── Scroll-and-scrape for large user lists ────────────────────────────────────

// Find the scrollable container that holds the user permission list.
// Accepts an optional searchRoot (permission section or document.body) so we only
// look inside the section that contains actual shared users.
function findUserListContainer(searchRoot = document.body) {
  const ROLE_INDICATORS = ['擁有者', '編輯者', '留言者', '檢視者', 'Owner', 'Editor'];
  const candidates = [];
  for (const el of searchRoot.querySelectorAll('*')) {
    if (el.scrollHeight <= el.clientHeight + 40) continue;
    const style = window.getComputedStyle(el);
    const oy = style.overflowY || style.overflow;
    if (oy !== 'auto' && oy !== 'scroll') continue;
    // Prefer containers whose text includes role labels (they contain the user list)
    const hasRoles = ROLE_INDICATORS.some(r => el.textContent.includes(r));
    candidates.push({ el, hasRoles, scrollH: el.scrollHeight });
  }
  if (candidates.length === 0) return null;
  // First prefer containers with role labels, then largest scrollHeight
  const withRoles = candidates.filter(c => c.hasRoles);
  const pool = withRoles.length > 0 ? withRoles : candidates;
  return pool.reduce((a, b) => b.scrollH > a.scrollH ? b : a).el;
}

// Scrape all users, scrolling through the list to handle virtual rendering.
// Scopes to findPermissionSection() so autocomplete suggestions are never included.
// For large lists (200+) Google may only render ~20 rows at a time in the DOM.
async function scrollAndScrapeAllUsers() {
  const allUsers = new Map(); // email → user data (deduped)

  function collect(newUsers) {
    for (const u of newUsers) {
      if (!allUsers.has(u.email)) allUsers.set(u.email, u);
    }
  }

  // Scope scraping to the "具有存取權的使用者" section (fallback: document.body)
  const section = findPermissionSection() || document.body;

  // Initial scrape at current scroll position
  collect(scrapeUsers(section));

  const container = findUserListContainer(section);
  if (!container) {
    // No scrollable container — list is short enough that all rows are visible
    return [...allUsers.values()];
  }

  // Scroll to top, then page through the list
  container.scrollTop = 0;
  await sleep(400);
  collect(scrapeUsers(section));

  const pageSize = Math.max(container.clientHeight * 0.85, 80);
  const maxIterations = 300; // safety cap for 200+ users
  let prevScrollTop = -1;

  for (let i = 0; i < maxIterations; i++) {
    container.scrollTop += pageSize;
    await sleep(350); // let virtual rendering catch up

    const current = container.scrollTop;
    if (current === prevScrollTop) break; // reached the bottom
    prevScrollTop = current;

    collect(scrapeUsers(section));

    if (current + container.clientHeight >= container.scrollHeight - 5) {
      collect(scrapeUsers(section));
      break;
    }
  }

  container.scrollTop = 0;
  return [...allUsers.values()];
}

// Scroll through the permission list to find a single user by email.
// Returns the user object with a FRESH _row reference valid right now,
// or null if not found.  Must be called with the sharing dialog open and
// the permission list already loaded (waitForPermissionList passed).
//
// This is necessary for lists with virtual scrolling (300+ users): a plain
// scrapeUsers() only sees the rows currently rendered in the DOM and misses
// users whose rows have been recycled off-screen.
async function scrollToFindUser(email) {
  const emailLower = email.toLowerCase();
  const section = findPermissionSection() || document.body;

  // Fast path: user is already visible at the current scroll position
  const quick = scrapeUsers(section).find(u => u.email === emailLower);
  if (quick) return quick;

  const container = findUserListContainer(section);
  if (!container) return null; // non-scrollable list — user just isn't there

  // Scroll from the top, scraping at each position
  container.scrollTop = 0;
  await sleep(350);

  const pageSize = Math.max(container.clientHeight * 0.85, 80);
  const maxIterations = 300;
  let prevScrollTop = -1;

  for (let i = 0; i < maxIterations; i++) {
    const found = scrapeUsers(section).find(u => u.email === emailLower);
    if (found) return found; // row is rendered → reference is valid now

    if (container.scrollTop === prevScrollTop) break; // reached the end
    prevScrollTop = container.scrollTop;
    container.scrollTop += pageSize;
    await sleep(300);
  }
  return null;
}

// ── DOM Read Users ────────────────────────────────────────────────────────────
async function domReadUsers() {
  try {
    const dialog = await openDialog();
    if (!dialog) {
      // Another dialog (e.g. 新增來源) is open — don't disrupt it
      if (findBlockingModal()) {
        return { success: false, reason: '頁面上有其他視窗開啟中，請先關閉後再重新整理 Share Manager' };
      }
      return { success: false, reason: '找不到共用按鈕，請確認頁面已載入完成' };
    }

    // Wait for the permission list to appear.
    // waitForPermissionList handles autocomplete dismissal internally:
    // every 1.5 s it retries dismissAutocomplete until the listbox is gone,
    // then checks whether role labels (擁有者/編輯者/…) are visible in the document.
    const loaded = await waitForPermissionList(dialog, 25000);
    if (!loaded) {
      await closeDialog();
      return { success: false, reason: '分享對話框載入逾時（200+ 人需要較長時間），請重試' };
    }

    // Extra wait to let the full list render before scrolling
    await sleep(600);

    // Scroll through the list to capture all users (handles virtual scrolling)
    const users = await scrollAndScrapeAllUsers();
    await closeDialog();

    return { success: true, users: users.map(({ email, name, role }) => ({ email, name, role })) };
  } catch (e) {
    try { await closeDialog(); } catch (_) {}
    return { success: false, reason: e.message };
  }
}

// ── DOM Add User ──────────────────────────────────────────────────────────────

// Type text into an input, firing all the events Angular/Lit/React frameworks need
// to pick up the change and trigger autocomplete.
function typeIntoInput(input, text) {
  input.focus();

  // Clear first using the native React/Angular value setter (bypasses framework memoisation)
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  if (nativeSetter) {
    nativeSetter.call(input, '');
  } else {
    input.value = '';
  }
  input.dispatchEvent(new InputEvent('input', { bubbles: true, cancelable: true }));

  // Now set the target value
  if (nativeSetter) {
    nativeSetter.call(input, text);
  } else {
    input.value = text;
  }

  // Fire a comprehensive set of events so every framework notices the change
  input.dispatchEvent(new InputEvent('input', { data: text, bubbles: true, cancelable: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keyup',  { bubbles: true }));
}

function findEmailInput(dialog) {
  const selectors = [
    'input[placeholder*="新增"]',
    'input[aria-label*="新增"]',
    'input[placeholder*="Add"]',
    'input[aria-label*="Add"]',
    'input[type="email"]',
    'input[role="combobox"]',
    'input[autocomplete]',
  ];
  for (const sel of selectors) {
    const el = dialog.querySelector(sel);
    if (el) return el;
  }
  // Fallback: first visible input
  return [...dialog.querySelectorAll('input')].find(i => i.offsetParent !== null) || null;
}

// Find the primary action button in the sharing dialog.
//   "傳送" (Send) — after adding or editing users
//   "儲存" (Save) — alternate label in some dialog states
// Always re-queries [role="dialog"] fresh because Google may re-render the dialog
// after a role-change selection, making a stale dialog reference miss the button.
function findSaveButton(dialogHint) {
  const dlg = findOpenSharingDialog() || dialogHint;
  if (!dlg) return null;

  const attrSelectors = [
    'button[aria-label*="傳送"]', 'button[aria-label*="Send"]',
    'button[aria-label*="儲存"]', 'button[aria-label*="Save"]',
    'button[aria-label*="Share"]', 'button[aria-label*="確認"]',
  ];
  for (const sel of attrSelectors) {
    const el = dlg.querySelector(sel);
    if (el && !el.disabled) return el;
  }
  // Text-based: use includes() so "傳送 (1)" or padded text still matches
  const KEYWORDS = ['傳送', '儲存', '確認', 'Send', 'Save', 'Share', 'Done'];
  for (const btn of dlg.querySelectorAll('button')) {
    if (btn.disabled) continue;
    const t = btn.textContent.trim();
    if (KEYWORDS.some(k => t.includes(k))) return btn;
  }
  return null;
}

// Poll for the save/send button until it appears and is enabled (up to maxWaitMs).
// After a role-change click the button may briefly be disabled while the UI updates.
async function clickSaveWhenReady(dialogHint, maxWaitMs = 4000) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const btn = findSaveButton(dialogHint);
    if (btn) { btn.click(); return true; }
    await sleep(200);
  }
  return false;
}

// Wait for NotebookLM's post-save toast and report what actually happened.
// Returns { ok: true } on the success toast, { ok: false, error } on the error
// toast ("分享筆記本時發生錯誤"), or { ok: false, error: '逾時未收到回應' } on timeout.
// This is the authoritative check — clicking 傳送 alone does NOT mean the share
// succeeded; NotebookLM can reject the whole send (e.g. invalid email / rate limit).
async function waitForSaveResult(timeoutMs = 8000) {
  const SUCCESS = ['筆記本分享成功', '分享成功', 'shared successfully', 'Notebook shared', 'Sharing updated'];
  const ERROR   = ['分享筆記本時發生錯誤', '發生錯誤', 'Error sharing', 'went wrong', 'try again'];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const body = document.body.textContent;
    if (ERROR.some(s => body.includes(s)))   return { ok: false, error: '分享筆記本時發生錯誤' };
    if (SUCCESS.some(s => body.includes(s))) return { ok: true };
    await sleep(300);
  }
  return { ok: false, error: '逾時未收到分享結果回應' };
}

// Find the role-selector button (e.g. "編輯者 ▾") in a user row.
// Clicking it opens the role dropdown with options incl. "移除存取權".
function findRoleButtonInRow(row) {
  const roleTexts = Object.keys(ROLE_MAP).filter(k => k !== '擁有者' && k !== 'Owner');
  // Prefer buttons that explicitly show a role label
  for (const btn of row.querySelectorAll('button, [role="button"], [role="combobox"]')) {
    if (roleTexts.some(t => btn.textContent.trim().includes(t))) return btn;
  }
  // Fallback: any button with aria-haspopup (dropdown indicator)
  for (const btn of row.querySelectorAll('[aria-haspopup], [aria-expanded]')) {
    if (btn.tagName === 'BUTTON' || btn.getAttribute('role') === 'button') return btn;
  }
  return null;
}

// Wait for autocomplete suggestions to appear, then click the best matching one.
// Searches document-wide because Google renders the listbox in a portal OUTSIDE
// [role="dialog"], so dialog.querySelectorAll() would find nothing.
async function handleAutocomplete(email) {
  // Give the autocomplete time to appear after typing
  await sleep(900);

  // Option items are in [role="option"] inside a [role="listbox"]
  const options = [...document.querySelectorAll('[role="listbox"] [role="option"], [role="option"]')];
  if (options.length === 0) return false;

  const emailLower = email.toLowerCase();

  // 1. Exact email match
  const exactMatch = options.find(o => o.textContent.toLowerCase().includes(emailLower));
  if (exactMatch) { exactMatch.click(); return true; }

  // 2. "新增 / Add" type option that contains the email address
  const addOption = options.find(o => {
    const t = o.textContent.toLowerCase();
    return (t.includes('新增') || t.includes('add')) && t.includes(emailLower);
  });
  if (addOption) { addOption.click(); return true; }

  // Do NOT click a random first option — it might add the wrong person.
  return false;
}

// Select a role in the sharing dialog after adding a user.
// The role dropdown appears next to the newly-added email chip.
async function selectRoleInDialog(dialog, role) {
  await sleep(600);

  const targetLabels = [ROLE_LABELS_ZH[role], ROLE_LABELS_EN[role], role].filter(Boolean);

  // Strategy 1: native <select> inside the dialog
  for (const sel of dialog.querySelectorAll('select')) {
    const opts = [...sel.options];
    const match = opts.find(o => targetLabels.some(l => o.text.includes(l) || o.value === role));
    if (match) {
      sel.value = match.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
  }

  // Strategy 2: custom dropdown button — search dialog-wide for a role button
  // (could be any role label: 編輯者, 檢視者, 留言者 as default for new chip)
  const roleTexts = Object.keys(ROLE_MAP).filter(k => k !== '擁有者' && k !== 'Owner');
  for (const btn of dialog.querySelectorAll('button, [role="button"], [role="combobox"]')) {
    const t = btn.textContent.trim();
    if (roleTexts.some(r => t.includes(r))) {
      btn.click();
      await sleep(500);
      // Look for target role in the opened menu (document-wide — portal rendered)
      for (const opt of document.querySelectorAll('[role="option"], [role="menuitem"], li')) {
        const ot = opt.textContent.trim();
        if (targetLabels.some(l => ot.includes(l)) && !ot.includes('移除')) {
          opt.click();
          return true;
        }
      }
      // Close the dropdown if target not found
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      return false;
    }
  }
  return false;
}

async function domAddUser(email, role) {
  try {
    const dialog = await openDialog();
    if (!dialog) {
      if (findBlockingModal()) {
        return { success: false, reason: '頁面上有其他視窗開啟中，請先關閉後再試' };
      }
      return { success: false, reason: '找不到共用按鈕' };
    }

    // Wait for dialog to stabilise, then dismiss the initial autocomplete
    // (which shows existing contacts, not the new user we want to add)
    await sleep(800);
    await dismissAutocomplete(dialog);
    await sleep(300);

    const input = findEmailInput(dialog);
    if (!input) {
      await closeDialog();
      return { success: false, reason: '找不到 email 輸入框' };
    }

    // Type the new email — fires comprehensive events so the framework notices
    typeIntoInput(input, email);

    // Try to click a matching autocomplete suggestion (document-wide search)
    const suggested = await handleAutocomplete(email);
    if (!suggested) {
      // No matching suggestion — confirm the typed email directly
      // keyCode 13 = Enter; some frameworks require both key and keyCode
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true,
      }));
      await sleep(600); // wait for email chip to be created
    }

    // Set role explicitly — always set even for 'reader' because the dialog
    // default might be '編輯者', not '檢視者'
    if (role) {
      await selectRoleInDialog(dialog, role);
    }

    // Click 傳送 (poll until the button becomes enabled after chip + role are set)
    const clicked = await clickSaveWhenReady(dialog, 5000);
    if (!clicked) {
      await closeDialog();
      return { success: false, reason: '找不到「傳送」按鈕（email 可能未加入成功）' };
    }
    const result = await waitForSaveResult(8000);
    await closeDialog();
    if (!result.ok) return { success: false, reason: result.error };
    return { success: true };
  } catch (e) {
    try { await closeDialog(); } catch (_) {}
    return { success: false, reason: e.message };
  }
}

// ── DOM Remove User ───────────────────────────────────────────────────────────
// Uses the role dropdown in each user row:
//   click role button → click "移除存取權" → click 儲存
async function domRemoveUser(email) {
  try {
    const dialog = await openDialog();
    if (!dialog) {
      if (findBlockingModal()) {
        return { success: false, reason: '頁面上有其他視窗開啟中，請先關閉後再試' };
      }
      return { success: false, reason: '找不到共用按鈕' };
    }

    const loaded = await waitForPermissionList(dialog, 10000);
    if (!loaded) { await closeDialog(); return { success: false, reason: '分享對話框載入逾時' }; }

    const target = await scrollToFindUser(email);
    if (!target) {
      await closeDialog();
      return { success: false, reason: `找不到用戶 ${email}` };
    }
    if (target.role === 'owner') {
      await closeDialog();
      return { success: false, reason: '無法移除擁有者' };
    }

    const row = target._row;

    // Open the role dropdown for this user row
    const roleBtn = findRoleButtonInRow(row);
    if (!roleBtn) {
      await closeDialog();
      return { success: false, reason: '找不到角色選單按鈕，對話框版面可能已更新' };
    }
    roleBtn.click();
    await sleep(500);

    // Click "移除存取權" in the opened dropdown
    const REMOVE_TEXTS = ['移除存取權', 'Remove access', '移除'];
    const menuItems = document.querySelectorAll(
      '[role="option"], [role="menuitem"], [role="listitem"], li'
    );
    let removed = false;
    for (const item of menuItems) {
      const t = item.textContent.trim();
      if (REMOVE_TEXTS.some(rt => t.includes(rt))) {
        item.click();
        removed = true;
        break;
      }
    }

    if (!removed) {
      await closeDialog();
      return { success: false, reason: '找不到「移除存取權」選項，對話框版面可能已更新' };
    }

    // Wait for UI to finish updating after option click, then click 傳送
    await sleep(600);
    const clicked = await clickSaveWhenReady(dialog, 4000);
    if (!clicked) {
      await closeDialog();
      return { success: false, reason: '找不到「傳送」按鈕，操作未儲存' };
    }

    // Confirm the save actually succeeded (not just that 傳送 was clicked)
    const result = await waitForSaveResult(8000);
    await closeDialog();
    if (!result.ok) return { success: false, reason: result.error };
    return { success: true };
  } catch (e) {
    try { await closeDialog(); } catch (_) {}
    return { success: false, reason: e.message };
  }
}

// ── DOM Update Role ───────────────────────────────────────────────────────────
// Uses the role dropdown in each user row:
//   click role button → click target role option → click 儲存
async function domUpdateRole(email, newRole) {
  try {
    const dialog = await openDialog();
    if (!dialog) {
      if (findBlockingModal()) {
        return { success: false, reason: '頁面上有其他視窗開啟中，請先關閉後再試' };
      }
      return { success: false, reason: '找不到共用按鈕' };
    }

    const loaded = await waitForPermissionList(dialog, 10000);
    if (!loaded) { await closeDialog(); return { success: false, reason: '分享對話框載入逾時' }; }

    const target = await scrollToFindUser(email);
    if (!target) {
      await closeDialog();
      return { success: false, reason: `找不到用戶 ${email}` };
    }
    if (target.role === 'owner') {
      await closeDialog();
      return { success: false, reason: '無法修改擁有者的角色' };
    }

    const row = target._row;

    // Open the role dropdown for this user row
    const roleBtn = findRoleButtonInRow(row);
    if (!roleBtn) {
      await closeDialog();
      return { success: false, reason: '找不到角色選單按鈕，對話框版面可能已更新' };
    }
    roleBtn.click();
    await sleep(500);

    // Click the target role option
    const targetLabels = [ROLE_LABELS_ZH[newRole], ROLE_LABELS_EN[newRole]].filter(Boolean);
    const menuItems = document.querySelectorAll(
      '[role="option"], [role="menuitem"], [role="listitem"], li'
    );
    let updated = false;
    for (const item of menuItems) {
      const t = item.textContent.trim();
      if (targetLabels.some(l => t.includes(l)) && !t.includes('移除')) {
        item.click();
        updated = true;
        break;
      }
    }

    if (!updated) {
      await closeDialog();
      return { success: false, reason: `找不到「${ROLE_LABELS_ZH[newRole] || newRole}」選項` };
    }

    // Wait for UI to finish updating after option click, then click 傳送
    await sleep(600);
    const clicked = await clickSaveWhenReady(dialog, 4000);
    if (!clicked) {
      await closeDialog();
      return { success: false, reason: '找不到「傳送」按鈕，操作未儲存' };
    }

    // Confirm the save actually succeeded (not just that 傳送 was clicked)
    const result = await waitForSaveResult(8000);
    await closeDialog();
    if (!result.ok) return { success: false, reason: result.error };
    return { success: true };
  } catch (e) {
    try { await closeDialog(); } catch (_) {}
    return { success: false, reason: e.message };
  }
}

// ── DOM Batch Process ─────────────────────────────────────────────────────────
//
// Strategy: group rows by action type (add / remove / update), then process
// each group in a SINGLE dialog session with ONE final 傳送 click.
// This reduces N dialog open/close/send cycles to at most 3, regardless of
// how many rows are in the batch.
//
// add    → open dialog once → add all email chips (each with role) → one Send
// remove → open dialog once → mark all users for removal           → one Save
// update → open dialog once → change all role dropdowns            → one Save

// Select role for the MOST RECENTLY added email chip (last role button in the
// dialog). Used when adding chips sequentially: after chip N is added its role
// button appears AFTER all previously finalized chip buttons.
async function selectRoleForLastChip(dialog, role) {
  await sleep(500);
  const targetLabels = [ROLE_LABELS_ZH[role], ROLE_LABELS_EN[role], role].filter(Boolean);

  // Strategy 1: last native <select> in dialog
  const selects = dialog.querySelectorAll('select');
  const lastSel = selects[selects.length - 1];
  if (lastSel) {
    const match = [...lastSel.options].find(o => targetLabels.some(l => o.text.includes(l) || o.value === role));
    if (match) { lastSel.value = match.value; lastSel.dispatchEvent(new Event('change', { bubbles: true })); return true; }
  }

  // Strategy 2: LAST role-labelled button in dialog (for the newly added chip)
  const roleTexts = Object.keys(ROLE_MAP).filter(k => k !== '擁有者' && k !== 'Owner');
  const roleBtns = [...dialog.querySelectorAll('button, [role="button"], [role="combobox"]')]
    .filter(btn => roleTexts.some(t => btn.textContent.trim().includes(t)));
  const lastBtn = roleBtns[roleBtns.length - 1];
  if (lastBtn) {
    lastBtn.click();
    await sleep(500);
    for (const opt of document.querySelectorAll('[role="option"], [role="menuitem"], li')) {
      const ot = opt.textContent.trim();
      if (targetLabels.some(l => ot.includes(l)) && !ot.includes('移除')) { opt.click(); return true; }
    }
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
  return false;
}

// NotebookLM caps a notebook's sharing list at 300 people (owner included).
const SHARE_LIMIT = 300;

// currentCount = how many people are ALREADY on the sharing list before this
// batch runs (passed from the sidebar = allPermissions.length). Removes run
// first to free up slots, then adds are capped so the list never exceeds 300.
async function domBatchProcess(rows, currentCount = 0) {
  const addRows    = rows.filter(r => r.action === 'add');
  const removeRows = rows.filter(r => r.action === 'remove');
  const updateRows = rows.filter(r => r.action === 'update');
  const allResults = [];

  // ── REMOVE first: free up sharing slots before adding (300-person cap) ─────
  if (removeRows.length) {
    try {
      const dialog = await openDialog();
      if (!dialog) {
        const msg = findBlockingModal() ? '頁面有其他視窗開啟' : '找不到共用按鈕';
        allResults.push(...removeRows.map(r => ({ line: r._line, email: r.email, action: 'remove', status: 'error', message: msg })));
      } else {
        const loaded = await waitForPermissionList(dialog, 25000);
        if (!loaded) {
          await closeDialog();
          allResults.push(...removeRows.map(r => ({ line: r._line, email: r.email, action: 'remove', status: 'error', message: '清單載入逾時' })));
        } else {
          await sleep(600);
          const pending = [];
          for (const row of removeRows) {
            const target = await scrollToFindUser(row.email);
            if (!target)              { allResults.push({ line: row._line, email: row.email, action: 'remove', status: 'error', message: '找不到此用戶' }); continue; }
            if (target.role==='owner'){ allResults.push({ line: row._line, email: row.email, action: 'remove', status: 'error', message: '無法移除擁有者' }); continue; }

            const roleBtn = findRoleButtonInRow(target._row);
            if (!roleBtn) { allResults.push({ line: row._line, email: row.email, action: 'remove', status: 'error', message: '找不到角色按鈕' }); continue; }

            roleBtn.click();
            await sleep(500);
            const REMOVE_TEXTS = ['移除存取權', 'Remove access', '移除'];
            let done = false;
            for (const item of document.querySelectorAll('[role="option"], [role="menuitem"], [role="listitem"], li')) {
              if (REMOVE_TEXTS.some(t => item.textContent.trim().includes(t))) { item.click(); done = true; break; }
            }
            if (!done) {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              allResults.push({ line: row._line, email: row.email, action: 'remove', status: 'error', message: '找不到移除選項' });
            } else {
              await sleep(400);
              pending.push(row);
            }
          }
          if (pending.length) {
            const clicked = await clickSaveWhenReady(dialog, 5000);
            const result  = clicked ? await waitForSaveResult(8000) : { ok: false, error: '傳送按鈕未出現' };
            if (result.ok) currentCount -= pending.length; // freed up these slots
            pending.forEach(r => allResults.push({
              line: r._line, email: r.email, action: 'remove',
              status: result.ok ? 'success' : 'error',
              message: result.ok ? undefined : result.error,
            }));
          }
          await closeDialog();
        }
      }
    } catch (e) {
      try { await closeDialog(); } catch (_) {}
      allResults.push(...removeRows.map(r => ({ line: r._line, email: r.email, action: 'remove', status: 'error', message: e.message })));
    }
  }

  // ── UPDATE: one dialog session, change all roles, one Save ───────────────
  if (updateRows.length) {
    try {
      const dialog = await openDialog();
      if (!dialog) {
        const msg = findBlockingModal() ? '頁面有其他視窗開啟' : '找不到共用按鈕';
        allResults.push(...updateRows.map(r => ({ line: r._line, email: r.email, action: 'update', status: 'error', message: msg })));
      } else {
        const loaded = await waitForPermissionList(dialog, 25000);
        if (!loaded) {
          await closeDialog();
          allResults.push(...updateRows.map(r => ({ line: r._line, email: r.email, action: 'update', status: 'error', message: '清單載入逾時' })));
        } else {
          await sleep(600);
          const pending = [];
          for (const row of updateRows) {
            const target = await scrollToFindUser(row.email);
            if (!target)               { allResults.push({ line: row._line, email: row.email, action: 'update', status: 'error', message: '找不到此用戶' }); continue; }
            if (target.role === 'owner'){ allResults.push({ line: row._line, email: row.email, action: 'update', status: 'error', message: '無法修改擁有者' }); continue; }

            const roleBtn = findRoleButtonInRow(target._row);
            if (!roleBtn) { allResults.push({ line: row._line, email: row.email, action: 'update', status: 'error', message: '找不到角色按鈕' }); continue; }

            roleBtn.click();
            await sleep(500);
            const targetLabels = [ROLE_LABELS_ZH[row.role], ROLE_LABELS_EN[row.role]].filter(Boolean);
            let done = false;
            for (const item of document.querySelectorAll('[role="option"], [role="menuitem"], [role="listitem"], li')) {
              const t = item.textContent.trim();
              if (targetLabels.some(l => t.includes(l)) && !t.includes('移除')) { item.click(); done = true; break; }
            }
            if (!done) {
              document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
              allResults.push({ line: row._line, email: row.email, action: 'update', status: 'error', message: `找不到${ROLE_LABELS_ZH[row.role]}選項` });
            } else {
              await sleep(400);
              pending.push(row);
            }
          }
          if (pending.length) {
            const clicked = await clickSaveWhenReady(dialog, 5000);
            const result  = clicked ? await waitForSaveResult(8000) : { ok: false, error: '傳送按鈕未出現' };
            pending.forEach(r => allResults.push({
              line: r._line, email: r.email, action: 'update',
              status: result.ok ? 'success' : 'error',
              message: result.ok ? undefined : result.error,
            }));
          }
          await closeDialog();
        }
      }
    } catch (e) {
      try { await closeDialog(); } catch (_) {}
      allResults.push(...updateRows.map(r => ({ line: r._line, email: r.email, action: 'update', status: 'error', message: e.message })));
    }
  }

  // ── ADD last, chunked + capped at the 300-person limit ────────────────────
  // NotebookLM rejects the WHOLE send ("分享筆記本時發生錯誤") when too many
  // recipients are queued in a single 傳送, so split into small chunks. Stop
  // adding once the list reaches SHARE_LIMIT; remaining rows are reported as
  // 'skipped' so the sidebar can list who was NOT added.
  const ADD_CHUNK_SIZE = 15;
  let i = 0;
  while (i < addRows.length) {
    const slotsLeft = SHARE_LIMIT - currentCount;
    if (slotsLeft <= 0) {
      // Cap reached — skip every remaining add and record it for the report.
      for (; i < addRows.length; i++) {
        const r = addRows[i];
        allResults.push({ line: r._line, email: r.email, action: 'add', status: 'skipped',
          message: `已達分享上限 ${SHARE_LIMIT} 人，未加入` });
      }
      break;
    }
    const chunk = addRows.slice(i, i + Math.min(ADD_CHUNK_SIZE, slotsLeft));
    i += chunk.length;
    try {
      const dialog = await openDialog();
      if (!dialog) {
        const msg = findBlockingModal() ? '頁面有其他視窗開啟' : '找不到共用按鈕';
        allResults.push(...chunk.map(r => ({ line: r._line, email: r.email, action: 'add', status: 'error', message: msg })));
        continue;
      }
      await sleep(800);
      await dismissAutocomplete(dialog);
      const pending = [];

      for (const row of chunk) {
        const input = findEmailInput(dialog);
        if (!input) {
          allResults.push({ line: row._line, email: row.email, action: 'add', status: 'error', message: '找不到輸入框' });
          break; // input gone — abort remaining adds in this chunk
        }
        typeIntoInput(input, row.email);
        const suggested = await handleAutocomplete(row.email);
        if (!suggested) {
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true, cancelable: true }));
          await sleep(600);
        }
        // Set role for the chip we just added (last role button in dialog)
        await selectRoleForLastChip(dialog, row.role);
        await sleep(200);
        pending.push(row);
      }

      if (pending.length) {
        const clicked = await clickSaveWhenReady(dialog, 8000);
        const result  = clicked ? await waitForSaveResult(10000) : { ok: false, error: '傳送按鈕未出現' };
        if (result.ok) currentCount += pending.length; // these now occupy slots
        pending.forEach(r => allResults.push({
          line: r._line, email: r.email, action: 'add',
          status: result.ok ? 'success' : 'error',
          message: result.ok ? undefined : result.error,
        }));
      }
      await closeDialog();
    } catch (e) {
      try { await closeDialog(); } catch (_) {}
      allResults.push(...chunk.map(r => ({ line: r._line, email: r.email, action: 'add', status: 'error', message: e.message })));
    }
  }

  return allResults;
}

// ── API 模式（v2.0）──────────────────────────────────────────────────────────
// 直接呼叫 NotebookLM 內部 RPC（經 inject-main.js 的 MAIN world 橋接），
// 一次取得全部分享名單、一次送出批次新增，不必開分享框也不必停留在畫面上。
// API 在「還沒改動任何東西之前」失敗時，自動退回原本的畫面模擬（dom*）流程。
const PERM_TO_ROLE = { 1: 'owner', 2: 'writer', 3: 'reader' };
// NotebookLM 分享只剩檢視者／編輯者兩級，舊 CSV 的 commenter 視同檢視者
const ROLE_TO_PERM = { writer: 2, commenter: 3, reader: 3 };
const API_ADD_CHUNK = 50;
let rpcSeq = 0;

function pageRpc(rpcid, params, timeoutMs = 20000) {
  const id = 'nlm' + (++rpcSeq) + '_' + Date.now();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { window.removeEventListener('message', onMsg); reject(new Error('API 逾時')); }, timeoutMs);
    function onMsg(e) {
      const r = e.source === window && e.data && e.data.__nlm_rpc_res;
      if (!r || r.id !== id) return;
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      r.ok ? resolve(r.data) : reject(new Error(r.error));
    }
    window.addEventListener('message', onMsg);
    window.postMessage({ __nlm_rpc_req: { id, rpcid, params, sourcePath: '/notebook/' + getNotebookId() } }, location.origin);
  });
}

async function apiShareStatus() {
  const nb = getNotebookId();
  if (!nb) throw new Error('找不到筆記本 ID');
  const data = await pageRpc('JFMDGd', [nb, [2]]);
  if (!Array.isArray(data)) throw new Error('分享狀態格式不符（可能不是擁有者）');
  const users = (Array.isArray(data[0]) ? data[0] : [])
    .filter(r => Array.isArray(r) && typeof r[0] === 'string')
    .map(r => ({
      email: r[0].toLowerCase(),
      name: (Array.isArray(r[3]) && r[3][0]) || r[0],
      role: PERM_TO_ROLE[r[1]] || 'reader',
    }));
  // API 回報的上限（maxIndividualsShareLimit）大於實際可分享人數；2026-10-05 實測非擁有者第 301 人即整包回 [3]，取兩者較小值
  return { users, limit: Math.min(typeof data[2] === 'number' ? data[2] : SHARE_LIMIT, SHARE_LIMIT) };
}

function shareParams(entries, notify, msgBlock) {
  return [[[getNotebookId(), entries.map(([email, perm]) => [email, null, perm]), null, msgBlock]],
          notify ? 1 : 0, null, [2]];
}

async function apiReadUsers() {
  const t0 = Date.now();
  const { users } = await apiShareStatus();
  return { success: true, users, mode: 'api', ms: Date.now() - t0 };
}

// 回傳格式與 domBatchProcess 相同：[{ line, email, action, status, message }]
async function apiBatchProcess(rows) {
  const { users, limit } = await apiShareStatus(); // 這裡失敗才會退回畫面模擬
  const current = new Map(users.map(u => [u.email, u]));
  const results = [];
  const push = (r, status, message) => results.push({ line: r._line, email: r.email, action: r.action, status, message });
  const sent = [];
  // RPC 回的錯誤不可盡信（notebooklm-py 實測：成功時也可能回狀態碼 [3]），先記下，最後一律以回讀判定
  const send = async (rs, entries, notify, msgBlock) => {
    let err = null;
    try { await pageRpc("QDyure", shareParams(entries, notify, msgBlock)); } catch (e) { err = e.message; }
    rs.forEach((r, i) => sent.push({ r, err, entry: entries[i], notify, msgBlock }));
  };

  // 先移除（騰出名額）。逐筆送：批次移除只要有一人不在名單，整包會被默默丟棄
  for (const r of rows.filter(r => r.action === 'remove')) {
    const u = current.get(r.email.toLowerCase());
    if (!u)                  { push(r, 'error', '找不到此用戶'); continue; }
    if (u.role === 'owner')  { push(r, 'error', '無法移除擁有者'); continue; }
    await send([r], [[u.email, 4]], false, [0, '']);
    current.delete(u.email);
  }

  // 修改權限：一次送出，不寄通知信
  const seen = new Set();
  const updates = [];
  for (const r of rows.filter(r => r.action === 'update')) {
    const email = r.email.toLowerCase();
    const u = current.get(email);
    if (seen.has(email))     { push(r, 'error', 'CSV 內重複'); continue; }
    seen.add(email);
    if (!u)                  { push(r, 'error', '找不到此用戶'); continue; }
    if (u.role === 'owner')  { push(r, 'error', '無法修改擁有者'); continue; }
    updates.push(r);
  }
  if (updates.length) {
    await send(updates, updates.map(r => [r.email.toLowerCase(), ROLE_TO_PERM[r.role] || 3]), false, [1, '']);
  }

  // 新增：依分享上限裁切，分批送出並寄通知信（與分享框預設勾選「通知使用者」一致）
  const adds = [];
  let count = [...current.values()].filter(u => u.role !== 'owner').length; // 上限只計非擁有者
  for (const r of rows.filter(r => r.action === 'add')) {
    const email = r.email.toLowerCase();
    if (seen.has(email))     { push(r, 'error', 'CSV 內重複'); continue; }
    seen.add(email);
    const u = current.get(email);
    if (u && u.role === 'owner') { push(r, 'error', '無法修改擁有者'); continue; }
    if (!u && count >= limit) { push(r, 'skipped', `已達分享上限 ${limit} 人，未加入`); continue; }
    if (!u) count++;
    adds.push(r);
  }
  for (let i = 0; i < adds.length; i += API_ADD_CHUNK) {
    const chunk = adds.slice(i, i + API_ADD_CHUNK);
    await send(chunk, chunk.map(r => [r.email.toLowerCase(), ROLE_TO_PERM[r.role] || 3]), true, [1, '']);
  }

  // 回讀驗證：伺服器對無效請求常回空結果不報錯、成功時又可能回錯誤碼，所以一律以回讀名單判定成敗
  if (sent.length) {
    const readBack = async () => {
      try { return new Map((await apiShareStatus()).users.map(u => [u.email, u])); } catch (_) { return null; }
    };
    const applied = (r, map) => {
      const u = map.get(r.email.toLowerCase());
      return r.action === 'remove' ? !u : !!(u && u.role === PERM_TO_ROLE[ROLE_TO_PERM[r.role] || 3]);
    };
    let after = await readBack();
    const domResult = new Map();

    if (after) {
      // 批次被整包拒絕（實測回 [3]：名單中只要有一個有問題的帳號就全部不生效）→ 逐筆重送，找出真正有問題的帳號。
      // 前 3 筆逐筆也全失敗，代表是參數格式問題而非個別帳號，不再逐筆硬送
      const retry = sent.filter(s => s.r.action !== 'remove' && !applied(s.r, after));
      if (retry.length > 1) {
        let tried = 0, okCount = 0;
        for (const s of retry) {
          if (tried >= 3 && okCount === 0) break;
          tried++;
          try { await pageRpc('QDyure', shareParams([s.entry], s.notify, s.msgBlock)); s.err = null; okCount++; }
          catch (e) { s.err = e.message; }
        }
        after = (await readBack()) || after;
      }
      // 仍未生效的新增／改權限，改用舊的畫面模擬流程再試一次，功能不中斷
      const still = sent.filter(s => s.r.action !== 'remove' && !applied(s.r, after)).map(s => s.r);
      if (still.length) {
        console.warn('[NLM-SM] API 寫入未生效，改用畫面模擬：', still.map(r => r.email));
        const dom = await domBatchProcess(still, after.size);
        for (const d of dom) domResult.set(d.line + '|' + d.email, d);
      }
    }

    for (const { r, err } of sent) {
      const d = domResult.get(r._line + '|' + r.email);
      if (d) { push(r, d.status, (d.message ? d.message + ' ' : '') + '（API 未生效，已改用畫面模擬）'); continue; }
      if (!after) {
        if (err) push(r, 'error', err + '（無法回讀確認，請按重新整理核對）');
        else push(r, 'success', '已送出，但無法回讀確認，請按重新整理核對');
        continue;
      }
      const ok = applied(r, after);
      push(r, ok ? 'success' : 'error', ok ? undefined : '送出後回讀未生效（帳號無效或被拒）' + (err ? '：' + err : ''));
    }
  }
  return results.sort((a, b) => (a.line || 0) - (b.line || 0));
}

async function apiSingle(action, email, role) {
  const [r] = await apiBatchProcess([{ _line: 1, action, email, role }]);
  return r.status === 'success' ? { success: true, mode: 'api' } : { success: false, reason: r.message };
}

// API 失敗（例如 Google 改版）時退回畫面模擬，功能不中斷
async function apiOrDom(name, apiFn, domFn) {
  try {
    return await apiFn();
  } catch (e) {
    console.warn('[NLM-SM] API 模式失敗，改用畫面模擬：', name, e);
    const r = await domFn();
    if (r && typeof r === 'object' && !Array.isArray(r)) r.mode = 'dom';
    return r;
  }
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  const { action } = msg;

  // Keep-alive messages
  if (action === 'ping') {
    sendResponse({ ok: true });
    return false;
  }
  if (action === 'registerTab') {
    sendResponse({ ok: true });
    return false;
  }

  // DOM operations (all async)
  const asyncActions = {
    readUsers:    () => apiOrDom("readUsers", apiReadUsers, domReadUsers),
    addUser:      () => apiOrDom("addUser", () => apiSingle("add", msg.email, msg.role), () => domAddUser(msg.email, msg.role)),
    removeUser:   () => apiOrDom("removeUser", () => apiSingle("remove", msg.email), () => domRemoveUser(msg.email)),
    updateUser:   () => apiOrDom("updateUser", () => apiSingle("update", msg.email, msg.role), () => domUpdateRole(msg.email, msg.role)),
    batchProcess: () => apiOrDom("batchProcess", () => apiBatchProcess(msg.rows), () => domBatchProcess(msg.rows, msg.currentCount || 0)),
  };

  if (asyncActions[action]) {
    asyncActions[action]().then(sendResponse).catch(e => sendResponse({ success: false, reason: e.message }));
    return true; // async response
  }

  return false;
});

// ── Sidebar injection ─────────────────────────────────────────────────────────
function getNotebookId() {
  const m = location.pathname.match(/\/notebook\/([a-zA-Z0-9_-]+)/);
  return m ? m[1] : null;
}

// ── 浮動視窗（v2.0，比照「CAAC 名單通知」擴充程式）─────────────────────────
// 右緣頁籤點一下開闔；標題列可拖曳移動、右下角可拉大小、「—」縮成標題列、「✕」收回頁籤。
// 位置／大小／開闔狀態存在 chrome.storage.local，換筆記本或重開 Chrome 都維持。
const PANEL_KEY = 'nlmSmPanelState';

function injectSidebar() {
  if (document.getElementById('nlm-sm-sidebar')) return;

  const btn = document.createElement('button');
  btn.id = 'nlm-sm-toggle';
  btn.title = 'NotebookLM 分享管理　點一下開闔視窗，按住可上下拖曳';
  btn.innerHTML = '<span class="nlm-sm-ico">👥</span><span>分享管理</span>';

  const panel = document.createElement('div');
  panel.id = 'nlm-sm-panel';
  panel.hidden = true;
  panel.innerHTML = `
    <div class="nlm-sm-head">
      <span class="nlm-sm-title">NotebookLM 分享管理 <em class="nlm-sm-ver"></em></span>
      <a class="nlm-sm-btn" data-act="min" title="縮小">—</a>
      <a class="nlm-sm-btn" data-act="ref" title="重新整理">⟳</a>
      <a class="nlm-sm-btn" data-act="close" title="收到右側頁籤">✕</a>
    </div>
    <div class="nlm-sm-grip" title="拖曳調整大小"></div>`;
  try { panel.querySelector('.nlm-sm-ver').textContent = 'v' + chrome.runtime.getManifest().version; } catch (_) {}

  const frame = document.createElement('iframe');
  frame.id = 'nlm-sm-sidebar';
  frame.src = chrome.runtime.getURL('sidebar.html') + '?notebookId=' + (getNotebookId() || '');
  panel.insertBefore(frame, panel.querySelector('.nlm-sm-grip'));
  document.body.appendChild(btn);
  document.body.appendChild(panel);

  const S = { open: false, min: false, h: 0 };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  function applyGeom(g) {
    const w = clamp(g.width || 440, 340, innerWidth - 20);
    S.h = clamp(g.height || Math.min(680, innerHeight - 100), 300, innerHeight - 20);
    panel.style.width = w + 'px';
    panel.style.height = S.h + 'px';
    panel.style.left = clamp(g.left != null ? g.left : innerWidth - w - 48, 0, innerWidth - 120) + 'px';
    panel.style.top = clamp(g.top != null ? g.top : 64, 0, innerHeight - 40) + 'px';
  }

  function save() {
    try {
      const r = panel.getBoundingClientRect();
      chrome.storage.local.set({ [PANEL_KEY]: {
        open: S.open, min: S.min, left: r.left, top: r.top,
        width: panel.offsetWidth, height: S.h, tabTop: btn.getBoundingClientRect().top } });
    } catch (_) { /* 擴充程式重新載入後舊分頁的 context 失效，忽略 */ }
  }

  function setOpen(open) {
    S.open = open;
    panel.hidden = !open;
    btn.classList.toggle('open', open);
    save();
  }

  function setMin(min) {
    S.min = min;
    panel.classList.toggle('mini', min);
    panel.style.height = min ? '' : S.h + 'px';
    panel.querySelector('[data-act="min"]').textContent = min ? '□' : '—';
    panel.querySelector('[data-act="min"]').title = min ? '還原' : '縮小';
  }

  // 拖曳期間 iframe 會吃掉 mousemove，暫時關掉它的滑鼠事件
  function onDrag(handle, begin) {
    handle.addEventListener('mousedown', (e) => {
      if (e.button !== 0 || e.target.closest('.nlm-sm-btn')) return;
      e.preventDefault();
      const sx = e.clientX, sy = e.clientY, h = begin();
      let moved = false;
      frame.style.pointerEvents = 'none';
      const mv = (ev) => {
        const dx = ev.clientX - sx, dy = ev.clientY - sy;
        if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
        h.move(dx, dy);
      };
      const up = () => {
        document.removeEventListener('mousemove', mv);
        document.removeEventListener('mouseup', up);
        frame.style.pointerEvents = '';
        h.done(moved);
      };
      document.addEventListener('mousemove', mv);
      document.addEventListener('mouseup', up);
    });
  }

  onDrag(panel.querySelector('.nlm-sm-head'), () => {
    const r = panel.getBoundingClientRect();
    return {
      move: (dx, dy) => {
        panel.style.left = clamp(r.left + dx, 0, innerWidth - 120) + 'px';
        panel.style.top = clamp(r.top + dy, 0, innerHeight - 40) + 'px';
      },
      done: save,
    };
  });

  onDrag(panel.querySelector('.nlm-sm-grip'), () => {
    const w = panel.offsetWidth, h = panel.offsetHeight;
    return {
      move: (dx, dy) => {
        panel.style.width = clamp(w + dx, 340, innerWidth - 20) + 'px';
        S.h = clamp(h + dy, 300, innerHeight - 20);
        panel.style.height = S.h + 'px';
      },
      done: save,
    };
  });

  // 頁籤貼齊右緣，只允許上下移動
  onDrag(btn, () => {
    const t = btn.getBoundingClientRect().top;
    return {
      move: (_dx, dy) => { btn.style.top = clamp(t + dy, 0, innerHeight - 60) + 'px'; btn.style.transform = 'none'; },
      done: (moved) => { if (moved) btn.dataset.dragged = '1'; save(); },
    };
  });

  btn.addEventListener('click', () => {
    if (btn.dataset.dragged === '1') { btn.dataset.dragged = '0'; return; }
    setOpen(!S.open);
  });

  panel.querySelector('.nlm-sm-head').addEventListener('click', (e) => {
    const act = e.target.closest('.nlm-sm-btn')?.dataset.act;
    if (act === 'min') { setMin(!S.min); save(); }
    else if (act === 'ref') frame.contentWindow.postMessage('nlm-sm-refresh', '*');
    else if (act === 'close') setOpen(false);
  });

  window.addEventListener('message', (e) => {
    if (e.data === 'nlm-sm-close') setOpen(false);
    // 側欄查詢筆記本標題（本擴充程式僅限「聯成人AI」筆記本，見 sidebar.js ALLOWED_NOTEBOOK）
    else if (e.data === 'nlm-sm-title?') frame.contentWindow.postMessage({ nlmSmTitle: document.title }, '*');
  });

  applyGeom({});
  try {
    chrome.storage.local.get(PANEL_KEY, (data) => {
      const st = data && data[PANEL_KEY];
      if (!st) return;
      applyGeom(st);
      if (st.tabTop != null) { btn.style.top = clamp(st.tabTop, 0, innerHeight - 60) + 'px'; btn.style.transform = 'none'; }
      setMin(!!st.min);
      S.open = !!st.open;
      panel.hidden = !S.open;
      btn.classList.toggle('open', S.open);
    });
  } catch (_) {}
}

// ── SPA navigation watcher ────────────────────────────────────────────────────
let lastUrl = location.href;
const observer = new MutationObserver(() => {
  if (location.href === lastUrl) return;
  lastUrl = location.href;
  const frame = document.getElementById('nlm-sm-sidebar');
  const id = getNotebookId();
  if (frame && id) {
    frame.src = chrome.runtime.getURL('sidebar.html') + '?notebookId=' + id;
  } else if (!frame && id) {
    injectSidebar();
  }
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectSidebar);
} else {
  injectSidebar();
}
observer.observe(document.body, { childList: true, subtree: true });
