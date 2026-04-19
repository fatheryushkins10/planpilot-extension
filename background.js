'use strict';

const API = 'https://planpilot-backend-9tf1.onrender.com';

// ── Setup alarm on install / browser start ─────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('canvas-sync', { periodInMinutes: 60 });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create('canvas-sync', { periodInMinutes: 60 });
});

// ── Alarm handler ──────────────────────────────────────────────────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'canvas-sync') return;
  await runSync();
});

// ── Core sync logic (mirrors popup.js) ────────────────────────────────────

async function getStorage(keys) {
  return new Promise(resolve => chrome.storage.local.get(keys, resolve));
}

async function apiFetch(path, opts = {}) {
  const { token, ...rest } = opts;
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...rest, headers });
  const data = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, data };
}

async function canvasFetchAll(domain, token, path) {
  const results = [];
  let page = 1;
  while (true) {
    const sep = path.includes('?') ? '&' : '?';
    const res = await fetch(`https://${domain}/api/v1${path}${sep}per_page=100&page=${page}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    if (!res.ok) break;
    const batch = await res.json();
    if (!batch.length) break;
    results.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return results;
}

async function runSync() {
  const { ppToken } = await getStorage(['ppToken']);
  if (!ppToken) return;

  // Verify token still valid
  const { ok: meOk } = await apiFetch('/api/auth/me', { token: ppToken });
  if (!meOk) return;

  // Get Canvas credentials from backend
  const { ok: tokOk, data: tokData } = await apiFetch('/api/canvas/token', { token: ppToken });
  if (!tokOk) return;

  const { domain, token: canvasToken } = tokData;
  const today = new Date().toISOString().slice(0, 10);

  try {
    const courses = await canvasFetchAll(domain, canvasToken, '/courses?enrollment_state=active&state[]=available');
    const assignments = [];

    for (const course of courses) {
      try {
        const list = await canvasFetchAll(domain, canvasToken,
          `/courses/${course.id}/assignments?order_by=due_at`);
        for (const a of list) {
          if (!a.due_at) continue;
          const due = a.due_at.slice(0, 10);
          if (due < today) continue;
          assignments.push({
            canvas_id: String(a.id),
            title: a.name || 'Untitled',
            description: a.description ? a.description.replace(/<[^>]*>/g, '').slice(0, 490) : '',
            due_date: due,
            course_name: course.name || course.course_code || '',
            submitted: !!(a.submission?.workflow_state && a.submission.workflow_state !== 'unsubmitted'),
          });
        }
      } catch (_) {}
    }

    if (!assignments.length) return;

    const { ok, data } = await apiFetch('/api/canvas/sync', {
      method: 'POST',
      token: ppToken,
      body: JSON.stringify({ assignments }),
    });

    if (ok && (data.created > 0 || data.updated > 0)) {
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'icons/icon-48.png',
        title: 'Roadmap — Canvas Synced',
        message: `${data.created} new · ${data.updated} updated · ${data.skipped} skipped`,
      });
    }
  } catch (_) {}
}
