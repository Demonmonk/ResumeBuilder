// dashboard.js — event delegation, zero inline onclick handlers
let applications = [];
let selectedId   = null;
let activeFilter = 'all';
let activeTab    = 'matches';

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadApps();
  setInterval(loadApps, 5000);

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderList();
    });
  });

  // Event delegation on sidebar list
  document.getElementById('job-list').addEventListener('click', e => {
    const item = e.target.closest('.job-item');
    if (!item) return;
    selectedId = item.dataset.id;
    const app = applications.find(a => a.id === selectedId);
    renderList();
    if (app) renderDetail(app);
  });

  // Event delegation on main panel
  document.getElementById('main').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const action = btn.dataset.action;
    const id     = btn.dataset.id || selectedId;
    if (action === 'approve')       approve(id);
    if (action === 'mark-applied')  markApplied(id);
    if (action === 'skip')          skipJob(id);
    if (action === 'delete')        deleteJob(id);
    if (action === 'retry')         retryJob(id);
    if (action === 'open-job')      openJob(id);
    if (action === 'regen-cover')   regenerateCover(id);
    if (action === 'copy-cover')    copyToClipboard('cover-editor');
    if (action === 'dl-cover')      downloadText(id, 'cover');
    if (action === 'dl-resume')     downloadText(id, 'resume');
    if (action === 'copy-bullet') {
      const idx = parseInt(btn.dataset.idx, 10);
      const app = applications.find(a => a.id === selectedId);
      if (app?.suggested_bullets?.[idx]) {
        navigator.clipboard.writeText(app.suggested_bullets[idx].bullet);
        btn.textContent = 'Copied!';
        setTimeout(() => { btn.textContent = 'Copy'; }, 1500);
      }
    }
  });

  // Tab delegation on main panel
  document.getElementById('main').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab || !tab.dataset.tab) return;
    activeTab = tab.dataset.tab;
    const app = applications.find(a => a.id === selectedId);
    if (app) renderDetail(app);
  });

  // Cover letter save on blur (delegated)
  document.getElementById('main').addEventListener('blur', e => {
    if (e.target.id === 'cover-editor') {
      saveCoverLetter(selectedId, e.target.value);
    }
  }, true);
}

// ── Load ──────────────────────────────────────────────────────────────────────
async function loadApps() {
  const resp = await chrome.runtime.sendMessage({ type: 'GET_APPS' });
  applications = (resp.applications || []).sort((a, b) => b.saved_at - a.saved_at);
  renderList();
  if (selectedId) {
    const app = applications.find(a => a.id === selectedId);
    if (app) renderDetail(app);
  }
}

// ── List ──────────────────────────────────────────────────────────────────────
function renderList() {
  const filtered = activeFilter === 'all'
    ? applications
    : applications.filter(a => a.status === activeFilter);

  const list = document.getElementById('job-list');
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state">No jobs here yet.</div>';
    return;
  }

  list.innerHTML = filtered.map(app => `
    <div class="job-item ${app.id === selectedId ? 'selected' : ''}" data-id="${app.id}">
      <div class="job-item-title">${esc(app.job_title)}</div>
      <div class="job-item-company">${esc(app.company)}</div>
      <div class="job-item-meta">
        <span class="badge badge-${app.status}">${statusLabel(app.status)}</span>
        <span class="job-item-date">${timeAgo(app.saved_at)}</span>
      </div>
    </div>
  `).join('');
}

// ── Detail ────────────────────────────────────────────────────────────────────
function renderDetail(app) {
  const main = document.getElementById('main');

  if (app.status === 'processing') {
    main.innerHTML = `
      <div class="detail">
        <div class="detail-header">
          <div>
            <div class="detail-title">${esc(app.job_title)}</div>
            <div class="detail-company">${esc(app.company)}</div>
          </div>
        </div>
        <div class="processing-state">
          <div class="spinner"></div>
          <div>Claude is tailoring your resume and writing your cover letter… ~20–30 seconds.</div>
        </div>
      </div>`;
    return;
  }

  if (app.status === 'error') {
    main.innerHTML = `
      <div class="detail">
        <div class="detail-header">
          <div>
            <div class="detail-title">${esc(app.job_title)}</div>
            <div class="detail-company">${esc(app.company)}</div>
          </div>
          <div class="detail-actions">
            <button class="btn btn-regen"   data-action="retry"  data-id="${app.id}">Retry</button>
            <button class="btn btn-delete"  data-action="delete" data-id="${app.id}">Delete</button>
          </div>
        </div>
        <div style="padding:16px;background:#1f0d0d;border:1px solid #3a1010;border-radius:10px;color:#f87171;font-size:13px">
          Error: ${esc(app.error || 'Unknown error')}
        </div>
      </div>`;
    return;
  }

  const isReady    = app.status === 'ready';
  const isApproved = app.status === 'approved';
  const isApplied  = app.status === 'applied';

  main.innerHTML = `
    <div class="detail">
      <div class="detail-header">
        <div>
          <div class="detail-title">${esc(app.job_title)}</div>
          <div class="detail-company">${esc(app.company)}</div>
          <div class="detail-url" data-action="open-job" data-id="${app.id}" style="cursor:pointer">Open job posting ↗</div>
        </div>
        <div class="detail-actions">
          ${isApplied  ? `<span class="badge badge-applied" style="padding:8px 14px;font-size:12px">✓ Applied</span>` : ''}
          ${isApproved ? `<button class="btn btn-apply"   data-action="mark-applied" data-id="${app.id}">Mark as Applied</button>` : ''}
          ${isReady    ? `<button class="btn btn-approve" data-action="approve"      data-id="${app.id}">Approve ✓</button>` : ''}
          ${!isApplied ? `<button class="btn btn-skip"    data-action="skip"         data-id="${app.id}">Skip</button>` : ''}
          <button class="btn btn-delete" data-action="delete" data-id="${app.id}">Delete</button>
        </div>
      </div>

      <div class="tabs">
        <div class="tab ${activeTab==='matches' ?'active':''}" data-tab="matches">Why you fit</div>
        <div class="tab ${activeTab==='resume'  ?'active':''}" data-tab="resume">Resume diff</div>
        <div class="tab ${activeTab==='cover'   ?'active':''}" data-tab="cover">Cover letter</div>
        <div class="tab ${activeTab==='bullets' ?'active':''}" data-tab="bullets">Suggested bullets ${(app.suggested_bullets||[]).length ? `<span class="tab-count">${app.suggested_bullets.length}</span>` : ''}</div>
        <div class="tab ${activeTab==='jd'      ?'active':''}" data-tab="jd">Job description</div>
      </div>

      <div class="tab-content ${activeTab==='matches'?'active':''}" id="tab-matches">
        <div class="section-label">Key matches</div>
        <div class="matches">
          ${(app.key_matches||[]).map(m=>`<div class="match-item">${esc(m)}</div>`).join('')}
        </div>
      </div>

      <div class="tab-content ${activeTab==='resume'?'active':''}" id="tab-resume">
        <div class="section-label">Changes — <span style="color:#4ade80">green = added</span> · <span style="color:#f87171">red = removed</span></div>
        <div class="diff">${renderDiff(app.resume_diff||[])}</div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-skip" style="flex:1" data-action="dl-resume" data-id="${app.id}">Download tailored resume</button>
        </div>
      </div>

      <div class="tab-content ${activeTab==='cover'?'active':''}" id="tab-cover">
        <div class="section-label">Cover letter — edit directly, then approve</div>
        <textarea class="cover-letter-editor" id="cover-editor">${esc(app.cover_letter||'')}</textarea>
        <div class="regen-row">
          <input class="regen-input" id="regen-note" placeholder='e.g. "Make it punchier" or "Emphasise Danaher more"'>
          <button class="btn btn-regen" data-action="regen-cover" data-id="${app.id}">Regenerate ↺</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-skip" style="flex:1" data-action="copy-cover">Copy</button>
          <button class="btn btn-skip" style="flex:1" data-action="dl-cover" data-id="${app.id}">Download</button>
        </div>
      </div>

      <div class="tab-content ${activeTab==='bullets'?'active':''}" id="tab-bullets">
        <div class="section-label">Bullets to add or swap into your resume — reframes of existing work or credible additions for gaps</div>
        ${(app.suggested_bullets||[]).length === 0
          ? `<div style="color:#555;font-size:13px;padding:16px 0">No suggested bullets yet — retry processing to regenerate.</div>`
          : (app.suggested_bullets||[]).map((b, i) => `
            <div class="bullet-card">
              <div class="bullet-card-top">
                <span class="bullet-type-badge ${b.type === 'new' ? 'badge-new' : 'badge-reframe'}">${b.type === 'new' ? 'New addition' : 'Reframe'}</span>
                <span class="bullet-context">${esc(b.context)}</span>
              </div>
              <div class="bullet-text">${esc(b.bullet)}</div>
              <button class="btn btn-copy-bullet" data-action="copy-bullet" data-idx="${i}">Copy</button>
            </div>
          `).join('')}
      </div>

      <div class="tab-content ${activeTab==='jd'?'active':''}" id="tab-jd">
        <div class="section-label">Original job description</div>
        <div style="font-size:13px;color:#666;line-height:1.8;white-space:pre-wrap;max-height:480px;overflow-y:auto;background:#0c0c14;padding:16px;border-radius:10px;border:1px solid #1e1e2a">${esc(app.raw_jd||'')}</div>
      </div>
    </div>`;
}

function renderDiff(diff) {
  if (!diff.length) return '<div class="diff-line diff-same">No diff available</div>';
  return diff.map(l => {
    if (l.type==='added')   return `<div class="diff-line diff-added">+ ${esc(l.text)}</div>`;
    if (l.type==='removed') return `<div class="diff-line diff-removed">- ${esc(l.text)}</div>`;
    return `<div class="diff-line diff-same">${esc(l.text)}</div>`;
  }).join('');
}

// ── Actions ───────────────────────────────────────────────────────────────────
async function approve(id) {
  await chrome.runtime.sendMessage({ type:'UPDATE_APP', id, updates:{ status:'approved' } });
  await loadApps();
}

async function markApplied(id) {
  await chrome.runtime.sendMessage({ type:'UPDATE_APP', id, updates:{ status:'applied', applied_at:Date.now() } });
  await loadApps();
}

async function skipJob(id) {
  await chrome.runtime.sendMessage({ type:'UPDATE_APP', id, updates:{ status:'skipped' } });
  selectedId = null;
  document.getElementById('main').innerHTML = '<div class="main-empty"><div class="big">✦</div><div>Select a job to review</div></div>';
  await loadApps();
}

async function deleteJob(id) {
  if (!confirm('Delete this application?')) return;
  await chrome.runtime.sendMessage({ type:'DELETE_APP', id });
  selectedId = null;
  document.getElementById('main').innerHTML = '<div class="main-empty"><div class="big">✦</div><div>Select a job to review</div></div>';
  await loadApps();
}

async function retryJob(id) {
  await chrome.runtime.sendMessage({ type:'RETRY_JOB', id });
  await loadApps();
}

async function saveCoverLetter(id, value) {
  if (!id) return;
  await chrome.runtime.sendMessage({ type:'UPDATE_APP', id, updates:{ cover_letter:value } });
}

async function regenerateCover(id) {
  const note  = document.getElementById('regen-note')?.value?.trim() || '';
  const app   = applications.find(a => a.id === id);
  const { profile, api_key } = await chrome.storage.local.get(['profile','api_key']);
  const el = document.getElementById('cover-editor');
  if (!el) return;
  el.value    = 'Regenerating…';
  el.disabled = true;

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': api_key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-opus-4-5',
        max_tokens: 1000,
        system: 'You are an expert cover letter writer. Rewrite based on the instruction. Max 3 short paragraphs. Return ONLY the cover letter text.',
        messages: [{ role:'user', content:
          `Job: ${app.job_title} at ${app.company}\nJD: ${app.raw_jd.slice(0,3000)}\nCurrent: ${app.cover_letter}\nInstruction: ${note||'Make it better'}`
        }]
      })
    });
    const data  = await resp.json();
    const newCL = data.content[0].text;
    el.value    = newCL;
    el.disabled = false;
    await chrome.runtime.sendMessage({ type:'UPDATE_APP', id, updates:{ cover_letter:newCL } });
    await loadApps();
  } catch (err) {
    el.value    = app.cover_letter;
    el.disabled = false;
    alert('Regeneration failed: ' + err.message);
  }
}

function openJob(id) {
  const app = applications.find(a => a.id === id);
  if (app?.url) chrome.tabs.create({ url: app.url });
}

function copyToClipboard(elId) {
  const el = document.getElementById(elId);
  if (el) navigator.clipboard.writeText(el.value || el.innerText);
}

function downloadText(id, type) {
  const app     = applications.find(a => a.id === id);
  if (!app) return;
  const content  = type === 'cover' ? app.cover_letter : app.tailored_resume;
  const filename = `${app.company}_${app.job_title}_${type}.txt`.replace(/[^\w_.-]/g, '_');
  const blob     = new Blob([content], { type:'text/plain' });
  const url      = URL.createObjectURL(blob);
  const a        = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// ── Utils ─────────────────────────────────────────────────────────────────────
function esc(str) {
  return String(str||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function statusLabel(s) {
  return {processing:'Processing',ready:'Ready',approved:'Approved',applied:'Applied',skipped:'Skipped',error:'Error'}[s]||s;
}
function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000)    return 'just now';
  if (d < 3600000)  return `${Math.floor(d/60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d/3600000)}h ago`;
  return `${Math.floor(d/86400000)}d ago`;
}

init();
