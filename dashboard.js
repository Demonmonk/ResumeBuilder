// dashboard.js
let applications = [];
let selectedId = null;
let activeFilter = 'all';
let activeTab = 'matches';
let profile = {};

const acceptedChanges = new Map();
const acceptedAdditions = new Map();

let refreshQueued = false;

function queueRefresh() {
  if (refreshQueued) return;
  refreshQueued = true;
  setTimeout(async () => {
    refreshQueued = false;
    await loadApps();
  }, 120);
}

function money(v) {
  if (v == null || Number.isNaN(Number(v))) return '—';
  return `$${Number(v).toFixed(4)}`;
}

function tokenLine(app) {
  const est = app.token_estimate || {};
  const usage = app.token_usage || {};
  const inTok = usage.input_tokens ?? est.input_tokens;
  const outTok = usage.output_tokens ?? est.output_tokens;
  const cost = app.actual_cost_usd ?? est.estimated_cost_usd;
  return `<div style="font-size:11px;color:#666;margin-top:6px">Tokens: in ${inTok ?? '—'} · out ${outTok ?? '—'} · est cost ${money(cost)}</div>`;
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  await loadApps();

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.applications || changes.profile) queueRefresh();
  });

  chrome.runtime.onMessage.addListener(msg => {
    if (msg?.type === 'APPS_UPDATED') queueRefresh();
  });

  document.querySelectorAll('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeFilter = btn.dataset.filter;
      renderList();
    });
  });

  document.getElementById('job-list').addEventListener('click', e => {
    const item = e.target.closest('.job-item');
    if (!item) return;
    selectedId = item.dataset.id;
    const app = applications.find(a => a.id === selectedId);
    renderList();
    if (app) renderDetail(app);
  });

  document.getElementById('main').addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn || btn.tagName === 'INPUT') return;
    const action = btn.dataset.action;
    const id = btn.dataset.id || selectedId;
    if (action === 'approve') approve(id);
    if (action === 'mark-applied') markApplied(id);
    if (action === 'skip') skipJob(id);
    if (action === 'delete') deleteJob(id);
    if (action === 'retry') retryJob(id);
    if (action === 'open-job') openJob(id);
    if (action === 'regen-cover') regenerateCover(id);
    if (action === 'copy-cover') copyToClipboard('cover-editor');
    if (action === 'dl-cover') downloadCover(id);
    if (action === 'dl-pdf') downloadResume(id, 'pdf');
    if (action === 'dl-word') downloadResume(id, 'word');
    if (action === 'dl-original') downloadOriginalResume(id);
  });

  document.getElementById('main').addEventListener('change', e => {
    const input = e.target;
    if (!input.dataset.action) return;
    const idx = parseInt(input.dataset.idx, 10);

    if (input.dataset.action === 'toggle-change') {
      const set = acceptedChanges.get(selectedId) || new Set();
      input.checked ? set.add(idx) : set.delete(idx);
      acceptedChanges.set(selectedId, set);
    }
    if (input.dataset.action === 'toggle-addition') {
      const set = acceptedAdditions.get(selectedId) || new Set();
      input.checked ? set.add(idx) : set.delete(idx);
      acceptedAdditions.set(selectedId, set);
    }

    const app = applications.find(a => a.id === selectedId);
    if (app) updatePageEstimate(app);
  });

  document.getElementById('main').addEventListener('click', e => {
    const tab = e.target.closest('.tab');
    if (!tab || !tab.dataset.tab) return;
    activeTab = tab.dataset.tab;
    const app = applications.find(a => a.id === selectedId);
    if (app) renderDetail(app);
  });

  document.getElementById('main').addEventListener('blur', e => {
    if (e.target.id === 'cover-editor') saveCoverLetter(selectedId, e.target.value);
  }, true);

  document.getElementById('btn-export-profile').addEventListener('click', async () => {
    const data = await chrome.storage.local.get(['profile', 'api_key']);
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'wingman-backup.json';
    a.click();
    URL.revokeObjectURL(url);
  });
}

async function loadApps() {
  const [appsResp, storage] = await Promise.all([
    chrome.runtime.sendMessage({ type: 'GET_APPS' }),
    chrome.storage.local.get('profile')
  ]);

  profile = storage.profile || {};
  applications = (appsResp.applications || []).sort((a, b) => b.saved_at - a.saved_at);
  renderList();
  if (selectedId) {
    const app = applications.find(a => a.id === selectedId);
    if (app) renderDetail(app);
  }
}

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
      ${tokenLine(app)}
    </div>
  `).join('');
}

function renderDetail(app) {
  const main = document.getElementById('main');

  if (app.status === 'processing') {
    main.innerHTML = `
      <div class="detail">
        <div class="detail-header">
          <div>
            <div class="detail-title">${esc(app.job_title)}</div>
            <div class="detail-company">${esc(app.company)}</div>
            ${tokenLine(app)}
          </div>
        </div>
        <div class="processing-state">
          <div class="spinner"></div>
          <div>Analysing your resume against the JD… ~20–30 seconds.</div>
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
            ${tokenLine(app)}
          </div>
          <div class="detail-actions">
            <button class="btn btn-regen" data-action="retry" data-id="${app.id}">Retry</button>
            <button class="btn btn-delete" data-action="delete" data-id="${app.id}">Delete</button>
          </div>
        </div>
        <div class="error-box">Error: ${esc(app.error || 'Unknown error')}</div>
      </div>`;
    return;
  }

  const isReady = app.status === 'ready';
  const isApproved = app.status === 'approved';
  const isApplied = app.status === 'applied';

  if (!acceptedChanges.has(app.id)) {
    acceptedChanges.set(app.id, new Set((app.changes || []).map((_, i) => i)));
  }
  if (!acceptedAdditions.has(app.id)) {
    acceptedAdditions.set(app.id, new Set((app.additions || []).map((_, i) => i)));
  }

  main.innerHTML = `
    <div class="detail">
      <div class="detail-header">
        <div>
          <div class="detail-title">${esc(app.job_title)}</div>
          <div class="detail-company">${esc(app.company)}</div>
          ${tokenLine(app)}
          <div class="detail-url" data-action="open-job" data-id="${app.id}" style="cursor:pointer">Open job posting ↗</div>
        </div>
        <div class="detail-actions">
          ${isApplied ? `<span class="badge badge-applied" style="padding:8px 14px;font-size:12px">✓ Applied</span>` : ''}
          ${isApproved ? `<button class="btn btn-apply" data-action="mark-applied" data-id="${app.id}">Mark as Applied</button>` : ''}
          ${isReady ? `<button class="btn btn-approve" data-action="approve" data-id="${app.id}">Approve ✓</button>` : ''}
          ${!isApplied ? `<button class="btn btn-skip" data-action="skip" data-id="${app.id}">Skip</button>` : ''}
          <button class="btn btn-delete" data-action="delete" data-id="${app.id}">Delete</button>
        </div>
      </div>

      <div class="tabs">
        <div class="tab ${activeTab === 'matches' ? 'active' : ''}" data-tab="matches">Why you fit</div>
        <div class="tab ${activeTab === 'changes' ? 'active' : ''}" data-tab="changes">Resume changes</div>
        <div class="tab ${activeTab === 'cover' ? 'active' : ''}" data-tab="cover">Cover letter</div>
        <div class="tab ${activeTab === 'jd' ? 'active' : ''}" data-tab="jd">Job description</div>
      </div>

      <div class="tab-content ${activeTab === 'matches' ? 'active' : ''}" id="tab-matches">
        <div class="section-label">Key matches</div>
        <div class="matches">
          ${(app.key_matches || []).map(m => `<div class="match-item">${esc(m)}</div>`).join('')}
        </div>
      </div>

      <div class="tab-content ${activeTab === 'changes' ? 'active' : ''}" id="tab-changes">
        ${renderChangesTab(app)}
      </div>

      <div class="tab-content ${activeTab === 'cover' ? 'active' : ''}" id="tab-cover">
        <div class="section-label">Cover letter — edit directly</div>
        <textarea class="cover-letter-editor" id="cover-editor">${esc(app.cover_letter || '')}</textarea>
        <div class="regen-row">
          <input class="regen-input" id="regen-note" placeholder='e.g. "Make it punchier" or "Lead with a stronger project"'>
          <button class="btn btn-regen" data-action="regen-cover" data-id="${app.id}">Regenerate ↺</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-skip" style="flex:1" data-action="copy-cover">Copy</button>
          <button class="btn btn-skip" style="flex:1" data-action="dl-cover" data-id="${app.id}">Download .txt</button>
        </div>
      </div>

      <div class="tab-content ${activeTab === 'jd' ? 'active' : ''}" id="tab-jd">
        <div class="section-label">Original job description</div>
        <div class="jd-text">${esc(app.raw_jd || '')}</div>
      </div>
    </div>`;
}

function renderChangesTab(app) {
  const changes = app.changes || [];
  const additions = app.additions || [];
  const chgSet = acceptedChanges.get(app.id) || new Set();
  const addSet = acceptedAdditions.get(app.id) || new Set();

  const changesHtml = changes.map((c, i) => `
    <label class="change-card ${chgSet.has(i) ? '' : 'dimmed'}">
      <input type="checkbox" data-action="toggle-change" data-idx="${i}" ${chgSet.has(i) ? 'checked' : ''}>
      <div class="change-body">
        <div class="change-section-tag">${esc(c.section || '')}</div>
        <div class="change-original">${esc(c.original || '')}</div>
        <div class="change-arrow">↓  <span class="change-reason-inline">${esc(c.reason || '')}</span></div>
        <div class="change-suggested">${esc(c.suggested || '')}</div>
      </div>
    </label>
  `).join('');

  const additionsHtml = additions.map((a, i) => `
    <label class="change-card ${addSet.has(i) ? '' : 'dimmed'}">
      <input type="checkbox" data-action="toggle-addition" data-idx="${i}" ${addSet.has(i) ? 'checked' : ''}>
      <div class="change-body">
        <div class="change-section-tag">
          <span class="type-badge ${a.type === 'new' ? 'badge-new' : 'badge-reframe'}">${a.type === 'new' ? 'New' : 'Reframe'}</span>
          ${esc(a.context || a.section || '')}
        </div>
        <div class="change-suggested">${esc(a.bullet || '')}</div>
        <div class="addition-reason">${esc(a.reason || '')}</div>
      </div>
    </label>
  `).join('');

  if (!changes.length && !additions.length) {
    return `<div style="color:#555;font-size:13px;padding:8px 0">No changes suggested — your resume already aligns well with this role.</div>${downloadButtons(app.id)}`;
  }

  return `
    ${changes.length ? `<div class="section-label" style="margin-top:0">Swap these bullets <span style="color:#444;font-weight:400;text-transform:none;letter-spacing:0">(uncheck to keep original)</span></div>${changesHtml}` : ''}
    ${additions.length ? `<div class="section-label" style="margin-top:${changes.length ? '20px' : '0'}">Add these bullets <span style="color:#444;font-weight:400;text-transform:none;letter-spacing:0">(uncheck to skip)</span></div>${additionsHtml}` : ''}
    <div id="page-estimate-row">${pageEstimateHtml(app)}</div>
    ${downloadButtons(app.id)}`;
}

function downloadButtons(id) {
  const wordLabel = profile.master_resume_docx
    ? 'Download Word (.docx) — format preserved'
    : 'Download Word (.doc)';

  return `<div class="download-row">
    <button class="btn btn-dl" data-action="dl-pdf" data-id="${id}">Save as PDF</button>
    <button class="btn btn-dl" data-action="dl-word" data-id="${id}">${wordLabel}</button>
    ${profile.master_resume_docx ? `<button class="btn btn-dl" data-action="dl-original" data-id="${id}">Original .docx</button>` : ''}
  </div>`;
}

function pageEstimateHtml(app) {
  const chgSet = acceptedChanges.get(app.id) || new Set();
  const addSet = acceptedAdditions.get(app.id) || new Set();
  const pages = estimatePages(app, chgSet, addSet);
  const target = profile.target_pages || 1;
  const over = pages > target + 0.15;

  return over
    ? `<div class="page-warning">⚠ ~${pages.toFixed(1)} pages — over your ${target}-page target. Deselect some items above.</div>`
    : `<div class="page-ok">~${pages.toFixed(1)} pages · target: ${target}</div>`;
}

function updatePageEstimate(app) {
  const el = document.getElementById('page-estimate-row');
  if (el) el.innerHTML = pageEstimateHtml(app);
}

function estimatePages(app, chgSet, addSet) {
  let text = profile.master_resume || '';
  (app.changes || []).forEach((c, i) => {
    if (chgSet.has(i) && c.original) text = text.replace(c.original, c.suggested || '');
  });
  (app.additions || []).forEach((a, i) => {
    if (addSet.has(i)) text += `\n${a.bullet || ''}`;
  });
  return Math.max(0.1, text.replace(/\s+/g, ' ').trim().length / 3000);
}

function buildFinalResume(app) {
  const chgSet = acceptedChanges.get(app.id) || new Set();
  const addSet = acceptedAdditions.get(app.id) || new Set();
  let text = profile.master_resume || '';

  (app.changes || []).forEach((c, i) => {
    if (chgSet.has(i) && c.original) text = text.replace(c.original, c.suggested || '');
  });

  (app.additions || []).forEach((a, i) => {
    if (!addSet.has(i)) return;
    const bullet = /^[•\-*]/.test((a.bullet || '').trim()) ? a.bullet : `• ${a.bullet}`;
    const sectionUpper = (a.section || '').toUpperCase().trim();
    const textUpper = text.toUpperCase();
    const sectionIdx = sectionUpper ? textUpper.indexOf(sectionUpper) : -1;
    if (sectionIdx !== -1) {
      const afterHeader = text.indexOf('\n', sectionIdx);
      if (afterHeader !== -1) {
        text = text.slice(0, afterHeader + 1) + bullet + '\n' + text.slice(afterHeader + 1);
        return;
      }
    }
    text += `\n${bullet}`;
  });

  return text;
}

function resumeToHtml(text) {
  function isHeader(line) {
    const t = line.trim();
    return t.length > 1 && t.length < 60 && t === t.toUpperCase() && /[A-Z]/.test(t) && !/^[•\-*]/.test(t);
  }

  let body = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) {
      body += '<div class="gap"></div>';
      continue;
    }
    if (isHeader(t)) {
      body += `<div class="hd">${esc(t)}</div>`;
      continue;
    }
    if (/^[•\-*]/.test(t)) {
      body += `<div class="bl">${esc(t)}</div>`;
      continue;
    }
    body += `<div class="ln">${esc(t)}</div>`;
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Resume</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
@page{size:letter;margin:.75in}
body{font-family:Arial,sans-serif;font-size:11pt;color:#000;line-height:1.45;background:#fff}
.bar{background:#f0f0f0;border-bottom:1px solid #ccc;padding:10px 16px;display:flex;gap:10px;align-items:center}
.bar button{padding:8px 20px;background:#000;color:#fff;border:none;border-radius:4px;font-size:13px;cursor:pointer;font-family:inherit}
.bar small{font-size:11px;color:#666}
.resume{padding:.5in .75in}
.hd{font-weight:700;text-transform:uppercase;letter-spacing:.8px;border-bottom:1.5px solid #000;margin:12pt 0 4pt;padding-bottom:2pt;font-size:10pt}
.bl{padding-left:12pt;margin:2pt 0}
.ln{margin:2pt 0}
.gap{height:5pt}
@media print{.bar{display:none}.resume{padding:0}}
</style></head><body>
<div class="bar">
  <button onclick="window.print()">Save as PDF</button>
  <small>Print dialog → Destination → Save as PDF</small>
</div>
<div class="resume">${body}</div>
</body></html>`;
}

function resumeToRtf(text) {
  function isHeader(line) {
    const t = line.trim();
    return t.length > 1 && t.length < 60 && t === t.toUpperCase() && /[A-Z]/.test(t) && !/^[•\-*]/.test(t);
  }
  function escRtf(s) {
    return s.replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
      .replace(/[^\x00-\x7F]/g, c => `\\u${c.charCodeAt(0)}?`);
  }

  let body = '';
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t) {
      body += '\\par\n';
      continue;
    }
    const e = escRtf(t);
    if (isHeader(t)) {
      body += `\\pard\\sb120\\sa40{\\b ${e}}\\par\n`;
      continue;
    }
    if (/^[•\-*]/.test(t)) {
      body += `\\pard\\li200\\fi-120 ${e}\\par\n`;
      continue;
    }
    body += `\\pard ${e}\\par\n`;
  }

  return `{\\rtf1\\ansi\\ansicpg1252\\deff0\n{\\fonttbl{\\f0\\fswiss\\fcharset0 Arial;}}\n\\f0\\fs22\\widowctrl\n${body}}`;
}

async function downloadResume(id, format) {
  const app = applications.find(a => a.id === id);
  if (!app) return;

  const chgSet = acceptedChanges.get(id) || new Set();
  const addSet = acceptedAdditions.get(id) || new Set();
  const accepted = {
    changes: (app.changes || []).filter((_, i) => chgSet.has(i)),
    additions: (app.additions || []).filter((_, i) => addSet.has(i))
  };

  const filename = `${app.company}_${app.job_title}`.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  const docxB64 = profile.master_resume_docx;

  if (format === 'word' && docxB64) {
    try {
      const btn = document.querySelector('[data-action="dl-word"]');
      if (btn) {
        btn.textContent = 'Building…';
        btn.disabled = true;
      }
      const modified = await applyChangesToDocx(docxB64, accepted.changes, accepted.additions);
      await downloadDocx(modified, filename);
      if (btn) {
        btn.textContent = 'Download Word (.docx)';
        btn.disabled = false;
      }
    } catch (err) {
      alert(`DOCX generation failed: ${err.message}`);
    }
    return;
  }

  const text = buildFinalResume(app);

  if (format === 'pdf') {
    const win = window.open('', '_blank');
    win.document.write(resumeToHtml(text));
    win.document.close();
  } else {
    const blob = new Blob([resumeToRtf(text)], { type: 'application/rtf' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${filename}.doc`;
    a.click();
    URL.revokeObjectURL(url);
  }
}

async function approve(id) {
  await chrome.runtime.sendMessage({ type: 'UPDATE_APP', id, updates: { status: 'approved' } });
}

async function markApplied(id) {
  await chrome.runtime.sendMessage({ type: 'UPDATE_APP', id, updates: { status: 'applied', applied_at: Date.now() } });
}

async function skipJob(id) {
  await chrome.runtime.sendMessage({ type: 'UPDATE_APP', id, updates: { status: 'skipped' } });
  selectedId = null;
  document.getElementById('main').innerHTML = '<div class="main-empty"><div class="big">✦</div><div>Select a job to review</div></div>';
}

async function deleteJob(id) {
  if (!confirm('Delete this application?')) return;
  await chrome.runtime.sendMessage({ type: 'DELETE_APP', id });
  selectedId = null;
  document.getElementById('main').innerHTML = '<div class="main-empty"><div class="big">✦</div><div>Select a job to review</div></div>';
}

async function retryJob(id) {
  await chrome.runtime.sendMessage({ type: 'RETRY_JOB', id });
}

async function saveCoverLetter(id, value) {
  if (!id) return;
  await chrome.runtime.sendMessage({ type: 'UPDATE_APP', id, updates: { cover_letter: value } });
}

async function regenerateCover(id) {
  const note = document.getElementById('regen-note')?.value?.trim() || '';
  const app = applications.find(a => a.id === id);
  const { api_key } = await chrome.storage.local.get('api_key');
  const el = document.getElementById('cover-editor');
  if (!el) return;

  el.value = 'Regenerating…';
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
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        system: 'Rewrite the cover letter based on the instruction. Max 3 short paragraphs. Return ONLY the cover letter text.',
        messages: [{
          role: 'user',
          content: `Job: ${app.job_title} at ${app.company}\nJD: ${(app.raw_jd || '').slice(0, 1800)}\nCurrent: ${app.cover_letter}\nInstruction: ${note || 'Make it better'}`
        }]
      })
    });
    const data = await resp.json();
    const newCL = data.content[0].text;
    el.value = newCL;
    el.disabled = false;
    await chrome.runtime.sendMessage({ type: 'UPDATE_APP', id, updates: { cover_letter: newCL } });
  } catch (err) {
    el.value = app.cover_letter;
    el.disabled = false;
    alert(`Regeneration failed: ${err.message}`);
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


function downloadOriginalResume(id) {
  const app = applications.find(a => a.id === id);
  if (!app || !profile.master_resume_docx) return;
  const filename = `${app.company}_${app.job_title}_original`.replace(/[^\w\s-]/g, '').replace(/\s+/g, '_');
  downloadDocx(profile.master_resume_docx, filename);
}

function downloadCover(id) {
  const app = applications.find(a => a.id === id);
  if (!app) return;
  const blob = new Blob([app.cover_letter || ''], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${app.company}_cover.txt`.replace(/[^\w_.-]/g, '_');
  a.click();
  URL.revokeObjectURL(url);
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function statusLabel(s) {
  return {
    processing: 'Processing',
    ready: 'Ready',
    approved: 'Approved',
    applied: 'Applied',
    skipped: 'Skipped',
    error: 'Error'
  }[s] || s;
}

function timeAgo(ts) {
  const d = Date.now() - ts;
  if (d < 60000) return 'just now';
  if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
  if (d < 86400000) return `${Math.floor(d / 3600000)}h ago`;
  return `${Math.floor(d / 86400000)}d ago`;
}

init();
