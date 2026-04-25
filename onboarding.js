// onboarding.js — API key first, then resume, then profile
let masterResume  = '';
let extractedName = '';
let savedApiKey   = '';
let docxBase64    = ''; // original DOCX stored for format-preserving downloads

function goTo(step) {
  document.querySelectorAll('.step').forEach(s => s.classList.remove('active'));
  const id = step === 'done' ? 'step-done' : `step-${step}`;
  document.getElementById(id).classList.add('active');
  if (step !== 'done') {
    for (let i = 0; i < 4; i++) {
      const dot = document.getElementById(`dot-${i}`);
      dot.className = 'step-dot' + (i < step ? ' done' : i === step ? ' active' : '');
    }
    document.getElementById('progress').style.display = 'flex';
  } else {
    document.getElementById('progress').style.display = 'none';
  }
}

// ── Button wiring ─────────────────────────────────────────────────────────────
document.getElementById('btn-welcome-next').addEventListener('click', () => goTo(1));
document.getElementById('btn-parse-paste').addEventListener('click', parsePastedResume);
document.getElementById('btn-api-back').addEventListener('click',     () => goTo(0));
document.getElementById('btn-api-next').addEventListener('click',     saveApiKey);
document.getElementById('btn-resume-back').addEventListener('click',  () => goTo(1));
document.getElementById('btn-resume-next').addEventListener('click',  resumeNext);
document.getElementById('btn-profile-back').addEventListener('click', () => goTo(2));
document.getElementById('btn-finish').addEventListener('click',       finish);
document.getElementById('btn-go-hunt').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://linkedin.com/jobs' });
  window.close();
});

// ── Step 1: Save API key ──────────────────────────────────────────────────────
async function saveApiKey() {
  const key = document.getElementById('api-key').value.trim();
  if (!key.startsWith('sk-ant-')) {
    showMsg('api', 'error', 'Key should start with sk-ant-');
    return;
  }
  showMsg('api', 'loading', 'Testing key…');
  document.getElementById('btn-api-next').disabled = true;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01','anthropic-dangerous-direct-browser-access':'true' },
      body: JSON.stringify({ model:'claude-haiku-4-5-20251001', max_tokens:10, messages:[{role:'user',content:'hi'}] })
    });
    if (!r.ok) {
      const e = await r.json().catch(()=>({}));
      throw new Error(e.error?.message || 'Invalid key');
    }
    savedApiKey = key;
    // Save key immediately so resume extraction can use it
    await chrome.storage.local.set({ api_key: key });
    showMsg('api', 'success', '✓ Key works!');
    setTimeout(() => goTo(2), 600);
  } catch (err) {
    showMsg('api', 'error', `Error: ${err.message}`);
    document.getElementById('btn-api-next').disabled = false;
  }
}

// ── Step 2: Resume upload ─────────────────────────────────────────────────────
const uploadZone = document.getElementById('upload-zone');
const fileInput  = document.getElementById('resume-file');

uploadZone.addEventListener('dragover',  e => { e.preventDefault(); uploadZone.classList.add('drag'); });
uploadZone.addEventListener('dragleave', () => uploadZone.classList.remove('drag'));
uploadZone.addEventListener('drop', e => {
  e.preventDefault(); uploadZone.classList.remove('drag');
  if (e.dataTransfer.files[0]) handleFileUpload(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', () => { if (fileInput.files[0]) handleFileUpload(fileInput.files[0]); });

async function handleFileUpload(file) {
  showMsg('resume', 'loading', 'Reading file…');
  docxBase64 = '';
  try {
    const ext = file.name.split('.').pop().toLowerCase();

    if (ext === 'docx' || ext === 'doc') {
      // Parse DOCX client-side — free, preserves format for downloads
      showMsg('resume', 'loading', 'Reading Word document…');
      const b64  = await readFileAsBase64(file);
      const text = await extractDocxText(b64); // from docx-editor.js
      if (!text || text.trim().length < 50) throw new Error('Could not extract text from this Word file. Try pasting below instead.');
      docxBase64 = b64; // save for format-preserving downloads
      showMsg('resume', 'loading', 'Claude is structuring your resume…');
      const resp = await chrome.runtime.sendMessage({ type:'EXTRACT_RESUME', resumeText: text });
      if (!resp.ok) throw new Error(resp.error);
      finishUpload(file.name, resp.data);
      return;
    }

    if (ext === 'pdf') {
      const b64  = await readFileAsBase64(file);
      const resp = await chrome.runtime.sendMessage({ type:'EXTRACT_RESUME_PDF', base64: b64 });
      if (!resp.ok) throw new Error(resp.error);
      finishUpload(file.name, resp.data);
      return;
    }

    // Plain text fallback
    const text = await readFileAsText(file);
    const nonPrintable = (text.match(/[\x00-\x08\x0E-\x1F\x7F-\xFF]/g) || []).length;
    if (text.length > 0 && nonPrintable / text.length > 0.15) {
      showMsg('resume', 'error', `"${file.name}" is a binary file. Upload a .docx or .pdf instead, or paste your resume below.`);
      return;
    }
    showMsg('resume', 'loading', 'Claude is structuring your resume…');
    const resp = await chrome.runtime.sendMessage({ type:'EXTRACT_RESUME', resumeText: text });
    if (!resp.ok) throw new Error(resp.error);
    finishUpload(file.name, resp.data);

  } catch (err) {
    showMsg('resume', 'error', `Error: ${err.message}`);
  }
}

function finishUpload(filename, data) {
  masterResume  = data.master_resume;
  extractedName = data.name || '';
  uploadZone.classList.add('done');
  uploadZone.querySelector('.upload-text').innerHTML = `<strong>✓ ${filename}</strong><br><small>Resume loaded${docxBase64 ? ' — format preserved ✓' : ''}</small>`;
  const preview = document.getElementById('resume-preview');
  preview.textContent = masterResume.slice(0, 800) + (masterResume.length > 800 ? '\n…' : '');
  preview.style.display = 'block';
  showMsg('resume', 'success', docxBase64
    ? '✓ Word doc parsed — your formatting will be preserved on download'
    : '✓ Resume extracted and ready');
  document.getElementById('btn-resume-next').disabled = false;
  prefillProfile(data);
}

async function parsePastedResume() {
  const text = document.getElementById('resume-paste').value.trim();
  if (text.length < 50) {
    showMsg('resume', 'error', 'Paste your full resume text first — at least a few lines.');
    return;
  }
  showMsg('resume', 'loading', 'Claude is extracting your details…');
  document.getElementById('btn-parse-paste').disabled = true;
  try {
    const resp = await chrome.runtime.sendMessage({ type: 'EXTRACT_RESUME', resumeText: text });
    if (!resp.ok) throw new Error(resp.error);
    masterResume = resp.data.master_resume;
    extractedName = resp.data.name || '';
    const preview = document.getElementById('resume-preview');
    preview.textContent = masterResume.slice(0, 600) + (masterResume.length > 600 ? '\n...' : '');
    preview.style.display = 'block';
    showMsg('resume', 'success', `✓ Got it — found: ${resp.data.name || '?'} · ${resp.data.email || '?'} · ${resp.data.phone || '?'}`);
    document.getElementById('btn-resume-next').disabled = false;
    prefillProfile(resp.data);
  } catch(err) {
    showMsg('resume', 'error', 'Error: ' + err.message);
  }
  document.getElementById('btn-parse-paste').disabled = false;
}

function prefillProfile(data) {
  extractedName = data.name || '';
  if (data.name)     document.getElementById('p-name').value     = data.name;
  if (data.email)    document.getElementById('p-email').value    = data.email;
  if (data.phone)    document.getElementById('p-phone').value    = data.phone;
  if (data.linkedin) document.getElementById('linkedin-url').value = data.linkedin;
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = e => resolve(e.target.result);
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsText(file);
  });
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload  = e => resolve(e.target.result.split(',')[1]);
    r.onerror = () => reject(new Error('Could not read file'));
    r.readAsDataURL(file);
  });
}

document.getElementById('linkedin-url').addEventListener('blur', async () => {
  const url = document.getElementById('linkedin-url').value.trim();
  if (!url.includes('linkedin.com/in/')) return;
  showMsg('resume', 'loading', 'Fetching LinkedIn profile…');
  try {
    const tab = await chrome.tabs.create({ url, active: false });
    await new Promise(resolve => {
      chrome.tabs.onUpdated.addListener(function fn(id, info) {
        if (id === tab.id && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(fn);
          setTimeout(resolve, 1500);
        }
      });
    });
    const [{ result }] = await chrome.scripting.executeScript({ target:{tabId:tab.id}, func:()=>document.body.innerText });
    chrome.tabs.remove(tab.id);
    showMsg('resume', 'loading', 'Claude is extracting your profile…');
    const resp = await chrome.runtime.sendMessage({ type:'EXTRACT_LINKEDIN', linkedinText: result.slice(0,12000) });
    if (!resp.ok) throw new Error(resp.error);
    masterResume  = resp.data.master_resume;
    extractedName = resp.data.name || '';
    const preview = document.getElementById('resume-preview');
    preview.textContent = masterResume.slice(0, 800) + '...';
    preview.style.display = 'block';
    showMsg('resume', 'success', '✓ LinkedIn profile extracted');
    document.getElementById('btn-resume-next').disabled = false;
    prefillProfile(resp.data);
  } catch (err) {
    showMsg('resume', 'error', `Could not extract: ${err.message}`);
  }
});

function resumeNext() {
  if (!masterResume) { showMsg('resume', 'error', 'Upload your resume or enter your LinkedIn URL first.'); return; }
  goTo(3);
}

// ── Step 3: Profile + save everything ────────────────────────────────────────
async function finish() {
  const name  = document.getElementById('p-name').value.trim();
  const email = document.getElementById('p-email').value.trim();
  if (!name || !email) { showMsg('profile', 'error', 'Name and email are required'); return; }

  const profile = {
    name, email,
    phone:               document.getElementById('p-phone').value.trim(),
    linkedin:            document.getElementById('linkedin-url').value.trim(),
    target_roles:        document.getElementById('p-roles').value.trim(),
    target_locations:    document.getElementById('p-locations').value.trim(),
    target_pages:        parseInt(document.getElementById('p-pages').value, 10) || 1,
    master_resume:       masterResume,
    master_resume_docx:  docxBase64 || undefined  // stored only when .docx was uploaded
  };

  const resp = await chrome.runtime.sendMessage({ type:'SAVE_PROFILE', profile, api_key: savedApiKey });
  if (resp.ok) { goTo('done'); }
  else { showMsg('profile', 'error', 'Could not save. Try again.'); }
}

// ── Msg helper ────────────────────────────────────────────────────────────────
function showMsg(section, type, text) {
  const el = document.getElementById(`${section}-msg`);
  el.className = `msg ${type}`;
  el.innerHTML = type === 'loading' ? `<div class="spinner"></div>${text}` : text;
}

// ── Export profile backup ─────────────────────────────────────────────────────
document.getElementById('btn-export-profile')?.addEventListener('click', async () => {
  const data = await chrome.storage.local.get(['profile', 'api_key']);
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url;
  a.download = 'wingman-profile-backup.json';
  a.click();
  URL.revokeObjectURL(url);
});

// ── Import profile backup ─────────────────────────────────────────────────────
document.getElementById('import-file')?.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await new Promise((res, rej) => {
      const r = new FileReader();
      r.onload  = ev => res(ev.target.result);
      r.onerror = () => rej(new Error('Read failed'));
      r.readAsText(file);
    });
    const data = JSON.parse(text);
    if (!data.profile || !data.api_key) throw new Error('Invalid backup file');
    await chrome.storage.local.set({
      profile:   data.profile,
      api_key:   data.api_key,
      onboarded: true
    });
    // Skip straight to done
    goTo('done');
    document.querySelector('.done-icon').textContent = '✓';
    document.querySelector('#step-done h1').textContent = 'Profile restored.';
    document.querySelector('#step-done .subtitle').textContent = 'All your data is back. Go find jobs.';
  } catch (err) {
    alert('Could not import: ' + err.message);
  }
});
