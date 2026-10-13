const STATUSES = ['New', 'Contacted', 'Quoted', 'Booked', 'Completed', 'Not going ahead'];
// Shown in the card header, so left out of the details list.
const HEADER_KEYS = new Set(['timestamp', 'childName', 'age', 'contactName', 'phone', 'email', 'status', 'notes', 'message']);
const LONG_KEYS = new Set(['message', 'notes']);

const state = {
  columns: [],
  enquiries: [],
  canEdit: false,
  search: '',
  status: '',
  sort: 'newest',
  editing: null, // row number of the card being edited
};

const $ = (sel, root = document) => root.querySelector(sel);

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(message, isError = false) {
  const el = $('#toast');
  el.textContent = message;
  el.classList.toggle('toast-error', isError);
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, isError ? 7000 : 2500);
}

async function api(path, options = {}) {
  const res = await fetch(path, { ...options, headers: { 'Content-Type': 'application/json' } });
  if (res.status === 401) {
    location.href = '/login';
    throw new Error('Signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

const col = (key) => state.columns.find((c) => c.key === key);
const pos = (key) => state.columns.findIndex((c) => c.key === key);
const val = (e, key) => {
  const i = pos(key);
  return i === -1 ? '' : e.values[i].trim();
};
const statusOf = (e) => val(e, 'status') || 'New';
const statusClass = (s) => `status-${s.toLowerCase().replace(/[^a-z]+/g, '-')}`;

// ------------------------------------------------------------------ loading

async function load(fresh = false) {
  const btn = $('#refresh-btn');
  btn.disabled = true;
  try {
    const data = await api(`/api/enquiries${fresh ? '?fresh=1' : ''}`);
    Object.assign(state, { columns: data.columns, enquiries: data.enquiries, canEdit: data.canEdit });
    const notice = $('#notice');
    notice.hidden = data.canEdit;
    notice.textContent = 'Read only: editing needs the Google service account set up (README, step 4).';
    fillStatusFilter();
    render();
    if (fresh) toast('Up to date with the sheet');
  } catch (err) {
    $('#list').innerHTML = `<div class="empty"><p><strong>The enquiries could not be loaded.</strong></p><p>${esc(err.message)}</p></div>`;
  } finally {
    btn.disabled = false;
    $('#list').setAttribute('aria-busy', 'false');
  }
}

function fillStatusFilter() {
  const used = new Set(state.enquiries.map(statusOf));
  const all = [...STATUSES, ...[...used].filter((s) => !STATUSES.includes(s)).sort()];
  $('#status-filter').innerHTML = '<option value="">All statuses</option>' +
    all.map((s) => `<option ${s === state.status ? 'selected' : ''}>${esc(s)}</option>`).join('');
}

// ------------------------------------------------------------------ rendering

function visible() {
  const q = state.search.toLowerCase();
  const list = state.enquiries.filter((e) =>
    (!state.status || statusOf(e) === state.status) &&
    (!q || e.values.join(' ').toLowerCase().includes(q))
  );
  // Sheet order is the order enquiries arrived.
  list.sort((a, b) => (state.sort === 'newest' ? b.row - a.row : a.row - b.row));
  return list;
}

function render() {
  const list = visible();
  $('#result-count').textContent = `${list.length} of ${state.enquiries.length} enquiries`;
  $('#list').innerHTML = list.length
    ? list.map((e) => (state.editing === e.row ? editHtml(e) : cardHtml(e))).join('')
    : '<p class="empty">No enquiries match. Clear the search or pick a different status.</p>';
}

function cardHtml(e) {
  const status = statusOf(e);
  const phone = val(e, 'phone');
  const email = val(e, 'email');
  const details = state.columns
    .map((c, i) => ({ c, v: e.values[i].trim() }))
    .filter(({ c, v }) => v && !c.hidden && !HEADER_KEYS.has(c.key))
    .map(({ c, v }) => `<div><dt>${esc(c.label)}</dt><dd>${esc(v)}</dd></div>`)
    .join('');
  const message = val(e, 'message');
  const notes = val(e, 'notes');

  return `<article class="card ${statusClass(status)}">
    <div class="card-top">
      <span class="badge">${esc(status)}</span>
      <span class="received">${esc(val(e, 'timestamp'))}</span>
      ${state.canEdit ? `<button class="btn btn-quiet btn-small" type="button" data-edit="${e.row}">Edit</button>` : ''}
    </div>
    <h2>${esc(val(e, 'childName') || 'Birthday child')}${val(e, 'age') ? ` <span class="age">turning ${esc(val(e, 'age'))}</span>` : ''}</h2>
    <p class="contact">
      ${esc(val(e, 'contactName'))}
      ${phone ? `<a href="tel:${esc(phone.replace(/[^\d+]/g, ''))}">${esc(phone)}</a>` : ''}
      ${email ? `<a href="mailto:${esc(email)}">${esc(email)}</a>` : ''}
    </p>
    ${details ? `<dl class="details">${details}</dl>` : ''}
    ${message ? `<p class="block"><strong>Their message</strong>${esc(message)}</p>` : ''}
    ${notes ? `<p class="block block-notes"><strong>Notes</strong>${esc(notes)}</p>` : ''}
  </article>`;
}

function editHtml(e) {
  const fields = state.columns
    .map((c, i) => ({ c, i, v: e.values[i] }))
    .filter(({ c }) => !c.hidden && c.key !== 'timestamp')
    .sort((a, b) => (a.c.key === 'status' ? -1 : b.c.key === 'status' ? 1 : 0))
    .map(({ c, i, v }) => {
      const id = `f-${e.row}-${i}`;
      let input;
      if (c.key === 'status') {
        const options = STATUSES.includes(v) || !v ? STATUSES : [v, ...STATUSES];
        input = `<select id="${id}" data-col="${c.index}">${options.map((s) =>
          `<option ${s === (v || 'New') ? 'selected' : ''}>${esc(s)}</option>`).join('')}</select>`;
      } else if (LONG_KEYS.has(c.key) || v.length > 60) {
        input = `<textarea id="${id}" data-col="${c.index}" rows="3">${esc(v)}</textarea>`;
      } else {
        input = `<input id="${id}" data-col="${c.index}" value="${esc(v)}">`;
      }
      const wide = LONG_KEYS.has(c.key) || v.length > 60 ? 'wide' : '';
      return `<label class="${wide}" for="${id}">${esc(c.label)}${input}</label>`;
    })
    .join('');

  return `<form class="card card-editing" data-row="${e.row}">
    <div class="card-top">
      <h2>Editing ${esc(val(e, 'childName') || 'enquiry')}</h2>
    </div>
    <p class="hint">Changes are saved straight into the Google Sheet.</p>
    <div class="edit-grid">${fields}</div>
    <div class="edit-actions">
      <button class="btn btn-primary" type="submit">Save to sheet</button>
      <button class="btn btn-quiet" type="button" data-cancel>Cancel</button>
    </div>
  </form>`;
}

// ------------------------------------------------------------------ saving

async function save(form) {
  const row = Number(form.dataset.row);
  const e = state.enquiries.find((x) => x.row === row);
  const changes = {};
  form.querySelectorAll('[data-col]').forEach((el) => {
    const i = state.columns.findIndex((c) => c.index === Number(el.dataset.col));
    const before = e.values[i];
    // An empty Status cell shows as "New"; don't write "New" unless it was changed.
    if (state.columns[i].key === 'status' && !before && el.value === 'New') return;
    if (el.value !== before) changes[el.dataset.col] = el.value;
  });
  if (!Object.keys(changes).length) {
    state.editing = null;
    render();
    return;
  }

  const btn = form.querySelector('[type=submit]');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    await api('/api/enquiries', {
      method: 'PATCH',
      body: JSON.stringify({ row, timestamp: val(e, 'timestamp'), changes }),
    });
    for (const [colIndex, value] of Object.entries(changes)) {
      e.values[state.columns.findIndex((c) => c.index === Number(colIndex))] = value;
    }
    state.editing = null;
    fillStatusFilter();
    render();
    toast('Saved to the sheet');
  } catch (err) {
    toast(err.message, true);
    btn.disabled = false;
    btn.textContent = 'Save to sheet';
  }
}

// ------------------------------------------------------------------ events

$('#list').addEventListener('click', (ev) => {
  const edit = ev.target.closest('[data-edit]');
  if (edit) {
    state.editing = Number(edit.dataset.edit);
    render();
    const first = $(`.card-editing select, .card-editing input`);
    if (first) first.focus();
    return;
  }
  if (ev.target.closest('[data-cancel]')) {
    state.editing = null;
    render();
  }
});

$('#list').addEventListener('submit', (ev) => {
  ev.preventDefault();
  save(ev.target);
});

let searchTimer;
$('#search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = ev.target.value.trim(); render(); }, 120);
});
$('#status-filter').addEventListener('change', (ev) => { state.status = ev.target.value; render(); });
$('#sort').addEventListener('change', (ev) => { state.sort = ev.target.value; render(); });
$('#refresh-btn').addEventListener('click', () => load(true));
$('#logout-btn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  location.href = '/login';
});

load();
