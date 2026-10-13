const STATUS_LABELS = {
  new: 'New',
  contacted: 'Contacted',
  quoted: 'Quoted',
  booked: 'Booked',
  completed: 'Completed',
  lost: 'Not going ahead',
};
const OPEN_STATUSES = ['new', 'contacted', 'quoted', 'booked'];
const QUICK_LOGS = ['Called – spoke to them', 'Called – left voicemail', 'Sent email', 'Sent SMS', 'Sent invoice', 'Deposit received'];
const DAY = 86400000;

const state = {
  enquiries: [],
  view: readPref('view', 'attention'),
  search: '',
  status: '',
  pkg: '',
  sort: readPref('sort', 'party-asc'),
  openId: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ------------------------------------------------------------------ helpers

function readPref(key, fallback) {
  try { return localStorage.getItem(`wh-${key}`) || fallback; } catch { return fallback; }
}
function writePref(key, value) {
  try { localStorage.setItem(`wh-${key}`, value); } catch {}
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function today() {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

function dateOnly(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d).getTime();
}

function toIso(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function partyDate(e) {
  return e.confirmedDate || e.partyDate;
}

function relativeDays(t) {
  const diff = Math.round((t - today()) / DAY);
  if (diff === 0) return 'today';
  if (diff === 1) return 'tomorrow';
  if (diff === -1) return 'yesterday';
  if (diff > 0) return diff < 60 ? `in ${diff} days` : `in ${Math.round(diff / 30)} months`;
  return -diff < 60 ? `${-diff} days ago` : `${Math.round(-diff / 30)} months ago`;
}

function formatDate(t, opts = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' }) {
  return new Date(t).toLocaleDateString('en-AU', opts);
}

function formatDateTime(iso) {
  return new Date(iso).toLocaleString('en-AU', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function telHref(phone) {
  return `tel:${String(phone).replace(/[^\d+]/g, '')}`;
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('toast-error', isError);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 6000 : 2500);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ------------------------------------------------------------------ derived flags

function isPast(e) {
  const d = dateOnly(partyDate(e));
  return d !== null && d < today();
}

function followUpDue(e) {
  const f = dateOnly(e.followUp);
  return f !== null && f <= today() && OPEN_STATUSES.includes(e.status);
}

function needsAttention(e) {
  if (followUpDue(e)) return true;
  // New enquiries for parties that haven't happened yet (or have no readable date).
  return e.status === 'new' && !isPast(e);
}

const VIEWS = {
  attention: { label: 'Needs attention', test: needsAttention },
  followups: { label: 'Follow-ups due', test: followUpDue },
  upcoming: { label: 'Upcoming parties', test: (e) => e.status === 'booked' && !isPast(e) },
  pipeline: { label: 'Quotes out', test: (e) => e.status === 'quoted' && !isPast(e) },
  active: { label: 'All open', test: (e) => OPEN_STATUSES.includes(e.status) && !isPast(e) },
  all: { label: 'Everything', test: () => true },
};

// ------------------------------------------------------------------ loading

async function load(fresh = false) {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  try {
    const data = await api(`/api/enquiries${fresh ? '?fresh=1' : ''}`);
    state.enquiries = data.enquiries;
    $('#user-name').textContent = `(${data.user})`;
    $('#sync-info').textContent = `Sheet read ${new Date(data.fetchedAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}`;
    fillPackageFilter();
    render();
    if (fresh) toast('Refreshed from the sheet');
  } catch (err) {
    $('#list').innerHTML = `<div class="empty"><p><strong>The enquiries could not be loaded.</strong></p><p>${esc(err.message)}</p></div>`;
  } finally {
    btn.disabled = false;
    $('#list').setAttribute('aria-busy', 'false');
  }
}

function fillPackageFilter() {
  const select = $('#package-filter');
  const packages = [...new Set(state.enquiries.map((e) => e.package).filter(Boolean))].sort();
  select.innerHTML = '<option value="">Any package</option>' +
    packages.map((p) => `<option ${p === state.pkg ? 'selected' : ''}>${esc(p)}</option>`).join('');
}

// ------------------------------------------------------------------ rendering

function filtered() {
  const q = state.search.toLowerCase();
  const view = VIEWS[state.view] || VIEWS.attention;
  let list = state.enquiries.filter((e) => {
    if (!view.test(e)) return false;
    if (state.status && e.status !== state.status) return false;
    if (state.pkg && e.package !== state.pkg) return false;
    if (q) {
      const hay = [e.contactName, e.childName, e.email, e.phone, e.message, e.notes, e.sheetNotes, e.partyDateRaw, e.quote]
        .join(' ').toLowerCase();
      if (!hay.includes(q) && !hay.replace(/\s/g, '').includes(q.replace(/\s/g, ''))) return false;
    }
    return true;
  });

  const party = (e) => dateOnly(partyDate(e)) ?? Infinity;
  const recv = (e) => (e.received ? Date.parse(e.received) : 0);
  const sorters = {
    'party-asc': (a, b) => party(a) - party(b) || recv(b) - recv(a),
    'received-desc': (a, b) => recv(b) - recv(a),
    'received-asc': (a, b) => recv(a) - recv(b),
  };
  list.sort(sorters[state.sort] || sorters['party-asc']);
  return list;
}

function render() {
  const all = state.enquiries;
  $('#tally-new').textContent = all.filter((e) => e.status === 'new' && !isPast(e)).length;
  $('#tally-followups').textContent = all.filter(followUpDue).length;
  $('#tally-upcoming').textContent = all.filter((e) => {
    const d = dateOnly(partyDate(e));
    return e.status === 'booked' && d !== null && d >= today() && d <= today() + 30 * DAY;
  }).length;
  $('#tally-pipeline').textContent = all.filter(VIEWS.pipeline.test).length;

  $$('.views [data-view]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.view === state.view)));
  $$('.tally').forEach((b) => b.classList.toggle('is-active', b.dataset.view === state.view));

  const list = filtered();
  const viewLabel = (VIEWS[state.view] || VIEWS.attention).label;
  $('#result-count').textContent = `${viewLabel}: ${list.length} ${list.length === 1 ? 'enquiry' : 'enquiries'}`;

  if (!list.length) {
    const hint = state.view === 'attention'
      ? 'Nothing is waiting on you. New form responses will appear here.'
      : 'No enquiries match. Try a different view or clear the search.';
    $('#list').innerHTML = `<p class="empty">${hint}</p>`;
    return;
  }

  $('#list').innerHTML = list.map(rowHtml).join('');
}

function dateTile(e) {
  const iso = partyDate(e);
  if (!iso) {
    return `<div class="tile tile-unknown" title="${esc(e.partyDateRaw || 'No date given')}"><span class="tile-day">?</span><span class="tile-month">date</span></div>`;
  }
  const t = dateOnly(iso);
  const unsure = !e.confirmedDate && e.partyDateUncertain;
  return `<div class="tile ${isPast(e) ? 'tile-past' : ''} ${unsure ? 'tile-unsure' : ''}" title="${unsure ? 'Best guess from “' + esc(e.partyDateRaw) + '” – confirm the date' : formatDate(t)}">
    <span class="tile-month">${formatDate(t, { month: 'short' })}</span>
    <span class="tile-day">${new Date(t).getDate()}</span>
    <span class="tile-dow">${formatDate(t, { weekday: 'short' })}</span>
  </div>`;
}

function rowHtml(e) {
  const iso = partyDate(e);
  const when = iso ? relativeDays(dateOnly(iso)) : 'no date yet';
  const due = followUpDue(e);
  const crew = [e.kids && `${e.kids} kids`, e.adults && `${e.adults} adults`].filter(Boolean).join(', ');
  return `<button class="row status-${e.status}" data-id="${e.id}" type="button">
    ${dateTile(e)}
    <span class="row-main">
      <span class="row-title">${esc(e.childName || 'Birthday star')}${e.age ? `<span class="row-age">turning ${esc(e.age)}</span>` : ''}</span>
      <span class="row-sub">${esc(e.contactName || e.email)}${e.phone ? ` · ${esc(e.phone)}` : ''}</span>
    </span>
    <span class="row-meta">
      <span class="row-package">${esc((e.package || 'No package chosen').replace(/ Party Package$/i, ''))}</span>
      <span class="row-crew">${esc(crew)}</span>
    </span>
    <span class="row-state">
      <span class="pill pill-${e.status}">${STATUS_LABELS[e.status]}</span>
      <span class="row-when">${due ? '<strong class="due">Follow up today</strong>' : esc(when)}</span>
    </span>
  </button>`;
}

// ------------------------------------------------------------------ detail panel

function openPanel(id) {
  const e = state.enquiries.find((x) => x.id === id);
  if (!e) return;
  state.openId = id;
  $('#panel-body').innerHTML = panelHtml(e);
  $('#panel').classList.add('is-open');
  $('#panel').setAttribute('aria-hidden', 'false');
  $('#scrim').hidden = false;
  document.body.classList.add('panel-open');
  $('#panel .panel-close').focus();
  loadActivity(id);
}

function closePanel() {
  const id = state.openId;
  state.openId = null;
  $('#panel').classList.remove('is-open');
  $('#panel').setAttribute('aria-hidden', 'true');
  $('#scrim').hidden = true;
  document.body.classList.remove('panel-open');
  const row = id && $(`.row[data-id="${id}"]`);
  if (row) row.focus();
}

function field(label, value) {
  if (!value) return '';
  return `<div class="fact"><dt>${label}</dt><dd>${esc(value)}</dd></div>`;
}

function emailTemplate(e) {
  const first = (e.contactName || '').trim().split(/\s+/)[0] || 'there';
  const subject = `${e.childName ? `${e.childName.trim()}'s` : 'Your'} birthday party at Woodhouse`;
  const body = `Hi ${first},\n\nThanks so much for your birthday party enquiry${e.childName ? ` for ${e.childName.trim()}` : ''}! \n\n`;
  return `mailto:${encodeURIComponent(e.email)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function panelHtml(e) {
  const iso = partyDate(e);
  const t = dateOnly(iso);
  const statusButtons = Object.entries(STATUS_LABELS).map(([key, label]) =>
    `<button type="button" class="seg seg-${key}" data-status="${key}" aria-pressed="${e.status === key}">${label}</button>`
  ).join('');

  return `
  <div class="panel-head">
    <div>
      <p class="panel-kicker">Enquiry received ${e.received ? formatDateTime(e.received) : esc(e.receivedRaw)}</p>
      <h2 id="panel-title">${esc(e.childName || 'Birthday star')}${e.age ? ` <span class="panel-age">turning ${esc(e.age)}</span>` : ''}</h2>
    </div>
    <button class="panel-close btn btn-quiet" type="button" aria-label="Close">Close</button>
  </div>

  <div class="panel-date">
    ${t !== null ? `<strong>${formatDate(t, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}</strong> <span>${relativeDays(t)}</span>` : '<strong>No party date yet</strong>'}
    ${!e.confirmedDate && e.partyDateUncertain && e.partyDateRaw ? `<p class="hint">Our best reading of “${esc(e.partyDateRaw)}”. Confirm the real date below.</p>` : ''}
    ${e.confirmedDate && e.partyDateRaw ? `<p class="hint">They wrote “${esc(e.partyDateRaw)}”.</p>` : ''}
  </div>

  <section class="contact">
    <p class="contact-name">${esc(e.contactName)}</p>
    <div class="contact-actions">
      ${e.phone ? `<a class="btn btn-primary" href="${telHref(e.phone)}">Call ${esc(e.phone)}</a>
        <a class="btn btn-quiet" href="sms:${esc(String(e.phone).replace(/[^\d+]/g, ''))}">Text</a>` : ''}
      ${e.email ? `<a class="btn btn-quiet" href="${emailTemplate(e)}">Email</a>
        <button class="btn btn-quiet" type="button" data-copy="${esc(e.email)}">Copy email</button>` : ''}
    </div>
  </section>

  <section class="manage" aria-label="Manage this enquiry">
    <h3>Status</h3>
    <div class="segments" role="group" aria-label="Status">${statusButtons}</div>

    <div class="manage-grid">
      <label>Confirmed party date
        <input type="date" data-field="confirmedDate" value="${esc(e.confirmedDate || '')}">
      </label>
      <label>Follow up on
        <input type="date" data-field="followUp" value="${esc(e.followUp || '')}">
        <span class="quick-dates">
          <button type="button" class="link" data-follow="1">Tomorrow</button>
          <button type="button" class="link" data-follow="3">In 3 days</button>
          <button type="button" class="link" data-follow="7">Next week</button>
        </span>
      </label>
      <label class="span-2">Quote / price
        <input type="text" data-field="quote" value="${esc(e.quote)}" placeholder="e.g. Silver, 12 kids – $540, deposit paid">
      </label>
      <label class="span-2">Notes
        <textarea data-field="notes" rows="4" placeholder="Allergies, special requests, what was agreed on the phone…">${esc(e.notes)}</textarea>
      </label>
    </div>
    <div class="save-row">
      <button type="button" class="btn btn-primary" id="save-btn">Save changes</button>
      <span class="hint" id="save-hint">${e.updatedBy ? `Last updated by ${esc(e.updatedBy)}, ${formatDateTime(e.updatedAt)}` : ''}</span>
    </div>
  </section>

  <section class="details">
    <h3>What they told us</h3>
    <dl class="facts">
      ${field('Package', e.package)}
      ${field('Kids coming', e.kids)}
      ${field('Grown-ups', e.adults)}
      ${field('Date they asked for', e.partyDateRaw)}
      ${field('Plan B date', e.planB)}
      ${field('Time of day', e.timeOfDay)}
      ${field('Camping', e.camping)}
      ${field('Party bags', e.partyBags)}
      ${field('Been to Woodhouse?', e.familiarity)}
      ${field('Email', e.email)}
    </dl>
    ${e.message ? `<h4>Their message</h4><blockquote>${esc(e.message)}</blockquote>` : ''}
    ${e.sheetNotes ? `<h4>Notes written in the sheet</h4><blockquote class="sheet-note">${esc(e.sheetNotes)}</blockquote>` : ''}
  </section>

  <section class="activity">
    <h3>Activity</h3>
    <div class="quick-logs">
      ${QUICK_LOGS.map((l) => `<button type="button" class="chip" data-log="${esc(l)}">${esc(l)}</button>`).join('')}
    </div>
    <ol id="activity-list" class="timeline"><li class="hint">Loading…</li></ol>
  </section>`;
}

async function loadActivity(id) {
  try {
    const { activity } = await api(`/api/enquiries/${id}/activity`);
    if (state.openId !== id) return;
    $('#activity-list').innerHTML = activity.length
      ? activity.map((a) => `<li><span class="tl-action">${esc(a.action)}</span><span class="tl-meta">${esc(a.by)} · ${formatDateTime(a.at)}</span></li>`).join('')
      : '<li class="hint">Nothing logged yet. Use the buttons above after you call or email.</li>';
  } catch (err) {
    $('#activity-list').innerHTML = `<li class="hint">${esc(err.message)}</li>`;
  }
}

async function saveChanges(id, changes, message = 'Saved') {
  const e = state.enquiries.find((x) => x.id === id);
  try {
    const { enquiry } = await api(`/api/enquiries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ ...changes, previousStatus: e.status }),
    });
    Object.assign(e, enquiry);
    render();
    if (state.openId === id) {
      const hint = $('#save-hint');
      if (hint) hint.textContent = `Last updated by ${enquiry.updatedBy}, ${formatDateTime(enquiry.updatedAt)}`;
      loadActivity(id);
    }
    toast(message);
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

function panelValues() {
  const values = {};
  $$('#panel [data-field]').forEach((el) => { values[el.dataset.field] = el.value; });
  return values;
}

// ------------------------------------------------------------------ export

function exportCsv() {
  const cols = [
    ['Status', (e) => STATUS_LABELS[e.status]],
    ['Party date', (e) => partyDate(e) || ''],
    ['Date as written', (e) => e.partyDateRaw],
    ['Child', (e) => e.childName],
    ['Age', (e) => e.age],
    ['Contact', (e) => e.contactName],
    ['Phone', (e) => e.phone],
    ['Email', (e) => e.email],
    ['Package', (e) => e.package],
    ['Kids', (e) => e.kids],
    ['Adults', (e) => e.adults],
    ['Quote', (e) => e.quote],
    ['Follow up', (e) => e.followUp || ''],
    ['Notes', (e) => e.notes],
    ['Received', (e) => e.received || e.receivedRaw],
  ];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.map(([h]) => cell(h)).join(',')]
    .concat(filtered().map((e) => cols.map(([, f]) => cell(f(e))).join(',')));
  const blob = new Blob([lines.join('\r\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `party-enquiries-${toIso(Date.now())}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

// ------------------------------------------------------------------ events

function setView(view) {
  state.view = view;
  writePref('view', view);
  render();
}

$$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));

$('#status-filter').innerHTML = '<option value="">Any status</option>' +
  Object.entries(STATUS_LABELS).map(([k, v]) => `<option value="${k}">${v}</option>`).join('');
$('#status-filter').addEventListener('change', (ev) => { state.status = ev.target.value; render(); });
$('#package-filter').addEventListener('change', (ev) => { state.pkg = ev.target.value; render(); });
$('#sort').value = state.sort;
$('#sort').addEventListener('change', (ev) => { state.sort = ev.target.value; writePref('sort', state.sort); render(); });

let searchTimer;
$('#search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = ev.target.value.trim(); render(); }, 120);
});

$('#list').addEventListener('click', (ev) => {
  const row = ev.target.closest('.row');
  if (row) openPanel(row.dataset.id);
});

$('#scrim').addEventListener('click', closePanel);
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape' && state.openId) closePanel();
  if (ev.key === '/' && document.activeElement === document.body) { ev.preventDefault(); $('#search').focus(); }
});

$('#panel').addEventListener('click', async (ev) => {
  const id = state.openId;
  const t = ev.target.closest('button');
  if (!t || !id) return;

  if (t.classList.contains('panel-close')) return closePanel();

  if (t.dataset.status) {
    const status = t.dataset.status;
    const ok = await saveChanges(id, { status }, `Marked as ${STATUS_LABELS[status].toLowerCase()}`);
    if (ok) $$('#panel .seg').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === status)));
    return;
  }

  if (t.dataset.follow) {
    $('#panel [data-field="followUp"]').value = toIso(today() + Number(t.dataset.follow) * DAY);
    return;
  }

  if (t.id === 'save-btn') {
    t.disabled = true;
    await saveChanges(id, panelValues(), 'Changes saved');
    t.disabled = false;
    return;
  }

  if (t.dataset.copy) {
    try { await navigator.clipboard.writeText(t.dataset.copy); toast('Email copied'); } catch { toast('Copy failed – select the address instead', true); }
    return;
  }

  if (t.dataset.log) {
    try {
      await api(`/api/enquiries/${id}/activity`, { method: 'POST', body: JSON.stringify({ action: t.dataset.log }) });
      const e = state.enquiries.find((x) => x.id === id);
      if (e.status === 'new') {
        await saveChanges(id, { status: 'contacted' }, 'Logged and marked as contacted');
        $$('#panel .seg').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.status === 'contacted')));
      } else {
        toast('Logged');
        loadActivity(id);
      }
    } catch (err) {
      toast(err.message, true);
    }
  }
});

$('#refresh-btn').addEventListener('click', () => load(true));
$('#logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});
$('#export-btn').addEventListener('click', exportCsv);

load();
