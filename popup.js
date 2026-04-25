// popup.js

let scrapedJob = null;

async function openReviewSurface(windowId) {
  if (chrome.sidePanel?.open) {
    await chrome.sidePanel.setOptions({
      path: 'dashboard.html',
      enabled: true
    });
    await chrome.sidePanel.open({ windowId });
    return;
  }
  chrome.tabs.create({ url: chrome.runtime.getURL('dashboard.html') });
}

async function init() {
  // Check onboarded
  const { onboarded } = await chrome.storage.local.get('onboarded');
  if (!onboarded) {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    window.close();
    return;
  }

  // Load stats
  loadStats();

  // Scrape current page
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const host = new URL(tab.url).hostname.replace('www.', '');
  document.getElementById('job-site').textContent = host;

  try {
    const resp = await chrome.tabs.sendMessage(tab.id, { type: 'SCRAPE_JD' });
    if (resp?.ok && resp.jd && resp.jd.length > 20) {
      scrapedJob = {
        job_title: resp.title || document.title || 'Unknown Role',
        company: resp.company || host,
        url: tab.url,
        raw_jd: resp.jd
      };
      document.getElementById('job-title').textContent = scrapedJob.job_title;
      document.getElementById('job-company').textContent = scrapedJob.company;
      document.getElementById('job-card').style.display = 'block';
      document.getElementById('no-job').style.display = 'none';
      document.getElementById('btn-save').disabled = false;
    }
  } catch (_) {
    // Not a job page — fine
  }
}

async function loadStats() {
  const { applications = [] } = await chrome.storage.local.get('applications');
  document.getElementById('num-ready').textContent = applications.filter(a => a.status === 'ready').length;
  document.getElementById('num-proc').textContent = applications.filter(a => a.status === 'processing').length;
  document.getElementById('num-applied').textContent = applications.filter(a => a.status === 'applied').length;
}

function showStatus(type, html) {
  const el = document.getElementById('status');
  el.className = `status ${type}`;
  el.innerHTML = html;
}

document.getElementById('btn-save').addEventListener('click', async () => {
  if (!scrapedJob) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  document.getElementById('btn-save').disabled = true;
  showStatus('saving', '<div class="spinner"></div> Saving & queueing…');

  const resp = await chrome.runtime.sendMessage({ type: 'SAVE_JOB', payload: scrapedJob });
  if (resp.ok) {
    const duplicateMsg = resp.duplicate ? 'Already saved earlier — reopening your review panel.' : 'Saved! Processing in background — opening review panel.';
    showStatus('saved', `✓ ${duplicateMsg}`);
    loadStats();
    await openReviewSurface(tab.windowId);
    window.close();
  } else {
    showStatus('error', 'Error saving job. Try again.');
    document.getElementById('btn-save').disabled = false;
  }
});

document.getElementById('btn-skip').addEventListener('click', () => window.close());

document.getElementById('open-settings').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
});

document.getElementById('open-dash').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await openReviewSurface(tab.windowId);
  window.close();
});

document.getElementById('stat-ready').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  await openReviewSurface(tab.windowId);
  window.close();
});

init();
