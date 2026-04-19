'use strict';

const API = 'https://planpilot-backend-9tf1.onrender.com';

// ── Helpers ────────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }

function showMsg(el, text, type = 'info') {
  el.textContent = text;
  el.className = `msg msg-${type}`;
  el.style.display = 'block';
}

function clearMsg(el) {
  el.textContent = '';
  el.style.display = 'none';
}

async function apiFetch(path, opts = {}) {
  const { token, ...rest } = opts;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  const res = await fetch(`${API}${path}`, { ...rest, headers });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

async function setStorage(obj) {
  return new Promise(resolve => chrome.storage.local.set(obj, resolve));
}

async function removeStorage(keys) {
  return new Promise(resolve => chrome.storage.local.remove(keys, resolve));
}

// ── Canvas helpers ─────────────────────────────────────────────────────────

async function canvasFetch(domain, token, path) {
  const res = await fetch(`https://${domain}/api/v1${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Canvas ${res.status}`);
  // Follow Link headers for pagination
  const data = await res.json();
  const link = res.headers.get('Link') || '';
  const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
  if (nextMatch) {
    const nextUrl = new URL(nextMatch[1]);
    const nextPath = nextUrl.pathname.replace('/api/v1', '') + nextUrl.search;
    const more = await canvasFetch(domain, token, nextPath);
    return Array.isArray(data) ? [...data, ...more] : data;
  }
  return data;
}

// ── Views ──────────────────────────────────────────────────────────────────

function showLogin() {
  $('view-login').style.display = 'block';
  $('view-main').style.display = 'none';
}

function showMain(email) {
  $('view-login').style.display = 'none';
  $('view-main').style.display = 'block';
  $('header-email').textContent = email || '';
}

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const { ppToken, ppEmail, ppCanvasDomain } = await getStorage(['ppToken', 'ppEmail', 'ppCanvasDomain']);

  if (!ppToken) { showLogin(); return; }

  // Verify token still valid
  const { ok } = await apiFetch('/api/auth/me', { token: ppToken });
  if (!ok) { await removeStorage(['ppToken', 'ppEmail']); showLogin(); return; }

  showMain(ppEmail);
  await renderCanvasState(ppToken, ppCanvasDomain);
}

// ── Canvas state ───────────────────────────────────────────────────────────

async function renderCanvasState(token, localDomain) {
  // Check backend connection status
  const { ok, data } = await apiFetch('/api/canvas/status', { token });
  const connected = ok && data.connected;

  if (connected) {
    const domain = data.domain || localDomain || '';
    $('canvas-domain-label').textContent = domain;
    $('canvas-connected').style.display = 'block';
    $('canvas-connect-form').style.display = 'none';
  } else {
    $('canvas-connected').style.display = 'none';
    $('canvas-connect-form').style.display = 'block';
  }
}

// ── Login ──────────────────────────────────────────────────────────────────

$('btn-login').addEventListener('click', async () => {
  const email = $('login-email').value.trim();
  const password = $('login-password').value;
  const msgEl = $('login-msg');

  if (!email || !password) { showMsg(msgEl, 'Please enter email and password.', 'error'); return; }

  $('btn-login').disabled = true;
  clearMsg(msgEl);

  const { ok, data } = await apiFetch('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });

  $('btn-login').disabled = false;

  if (!ok) {
    showMsg(msgEl, data.error || 'Sign in failed.', 'error');
    return;
  }

  // Backend uses HttpOnly cookies normally; for the extension we need a token.
  // The login endpoint also returns an accessToken in the body for non-browser clients.
  const accessToken = data.accessToken || data.token;
  if (!accessToken) {
    showMsg(msgEl, 'No token returned. Check backend version.', 'error');
    return;
  }

  await setStorage({ ppToken: accessToken, ppEmail: email });
  showMain(email);
  await renderCanvasState(accessToken, null);
});

// ── Logout ─────────────────────────────────────────────────────────────────

$('btn-logout').addEventListener('click', async () => {
  const { ppToken } = await getStorage(['ppToken']);
  if (ppToken) await apiFetch('/api/auth/logout', { method: 'POST', token: ppToken }).catch(() => {});
  await removeStorage(['ppToken', 'ppEmail', 'ppCanvasDomain']);
  showLogin();
});

// ── Canvas connect ─────────────────────────────────────────────────────────

$('canvas-domain').addEventListener('input', () => {
  const domain = $('canvas-domain').value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '');
  const link = $('canvas-settings-link');
  if (domain.length > 3) {
    link.href = `https://${domain}/profile/settings`;
    link.style.display = 'block';
  } else {
    link.style.display = 'none';
  }
});

$('btn-canvas-connect').addEventListener('click', async () => {
  const rawDomain = $('canvas-domain').value.trim().replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
  const token = $('canvas-token').value.trim();
  const msgEl = $('canvas-connect-msg');

  if (!rawDomain || !token) { showMsg(msgEl, 'Enter Canvas domain and token.', 'error'); return; }

  $('btn-canvas-connect').disabled = true;
  showMsg(msgEl, 'Validating token…', 'info');

  // Validate token by calling Canvas directly (extension bypasses CORS)
  try {
    await canvasFetch(rawDomain, token, '/users/self');
  } catch (e) {
    showMsg(msgEl, `Canvas error: ${e.message}. Check domain and token.`, 'error');
    $('btn-canvas-connect').disabled = false;
    return;
  }

  // Save to backend
  const { ppToken } = await getStorage(['ppToken']);
  const { ok, data } = await apiFetch('/api/canvas/connect', {
    method: 'POST',
    token: ppToken,
    body: JSON.stringify({ domain: rawDomain, token }),
  });

  $('btn-canvas-connect').disabled = false;

  if (!ok) { showMsg(msgEl, data.error || 'Failed to save.', 'error'); return; }

  await setStorage({ ppCanvasDomain: rawDomain });
  clearMsg(msgEl);
  await renderCanvasState(ppToken, rawDomain);
});

// ── Canvas disconnect ──────────────────────────────────────────────────────

$('btn-canvas-disconnect').addEventListener('click', async () => {
  const { ppToken } = await getStorage(['ppToken']);
  await apiFetch('/api/canvas/disconnect', { method: 'DELETE', token: ppToken });
  await removeStorage(['ppCanvasDomain']);
  await renderCanvasState(ppToken, null);
});

// ── Canvas sync ────────────────────────────────────────────────────────────

$('btn-sync').addEventListener('click', async () => {
  const msgEl = $('canvas-msg');
  const { ppToken, ppCanvasDomain } = await getStorage(['ppToken', 'ppCanvasDomain']);

  $('btn-sync').disabled = true;
  $('sync-result').style.display = 'none';
  showMsg(msgEl, 'Fetching courses…', 'info');

  try {
    // Get domain + token from backend (source of truth)
    const { ok: tokOk, data: tokData } = await apiFetch('/api/canvas/token', { token: ppToken });
    if (!tokOk) throw new Error(tokData.error || 'Could not retrieve Canvas token.');

    const { domain, token: canvasToken } = tokData;

    showMsg(msgEl, 'Fetching courses…', 'info');
    const courses = await canvasFetch(domain, canvasToken, '/courses?enrollment_state=active&per_page=50');
    const activeCourses = courses.filter(c => c.workflow_state === 'available' || !c.workflow_state);

    showMsg(msgEl, `Found ${activeCourses.length} courses. Fetching assignments…`, 'info');

    const today = new Date().toISOString().slice(0, 10);
    const assignments = [];

    for (const course of activeCourses) {
      try {
        const raw = await canvasFetch(
          domain, canvasToken,
          `/courses/${course.id}/assignments?per_page=50&order_by=due_at`,
        );

        for (const a of raw) {
          if (!a.due_at) continue;
          const due = a.due_at.slice(0, 10);
          if (due < today) continue;

          assignments.push({
            canvas_id: String(a.id),
            title: a.name || 'Untitled',
            description: a.description
              ? a.description.replace(/<[^>]*>/g, '').slice(0, 490)
              : '',
            due_date: due,
            course_name: course.name || course.course_code || '',
            submitted: !!(a.submission?.workflow_state && a.submission.workflow_state !== 'unsubmitted'),
          });
        }
      } catch (_) {
        // Skip courses we can't access
      }
    }

    showMsg(msgEl, `Syncing ${assignments.length} assignments…`, 'info');

    const { ok, data } = await apiFetch('/api/canvas/sync', {
      method: 'POST',
      token: ppToken,
      body: JSON.stringify({ assignments }),
    });

    if (!ok) throw new Error(data.error || 'Sync failed.');

    $('sync-created').textContent = data.created ?? 0;
    $('sync-updated').textContent = data.updated ?? 0;
    $('sync-skipped').textContent = data.skipped ?? 0;
    $('sync-result').style.display = 'flex';
    showMsg(msgEl, 'Sync complete!', 'success');
  } catch (e) {
    showMsg(msgEl, e.message, 'error');
  } finally {
    $('btn-sync').disabled = false;
  }
});

// ── Start ──────────────────────────────────────────────────────────────────

init();
