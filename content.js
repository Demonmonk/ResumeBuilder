// content.js — runs on every page
// Handles: JD scraping, form field filling from vision instructions

// ── JD Scrapers ───────────────────────────────────────────────────────────────

function scrapeLinkedIn() {
  // Title — try multiple known selectors
  const title =
    document.querySelector('h1.t-24')?.innerText?.trim() ||
    document.querySelector('h1[class*="job-title"]')?.innerText?.trim() ||
    document.querySelector('.job-details-jobs-unified-top-card__job-title h1')?.innerText?.trim() ||
    document.querySelector('h1')?.innerText?.trim();

  // Company
  const company =
    document.querySelector('.job-details-jobs-unified-top-card__company-name a')?.innerText?.trim() ||
    document.querySelector('[class*="company-name"] a')?.innerText?.trim() ||
    document.querySelector('[class*="company-name"]')?.innerText?.trim() ||
    document.querySelector('.topcard__org-name-link')?.innerText?.trim();

  // JD — cast a wide net
  const jd =
    document.querySelector('.jobs-description__content')?.innerText?.trim() ||
    document.querySelector('[class*="jobs-description"]')?.innerText?.trim() ||
    document.querySelector('#job-details')?.innerText?.trim() ||
    document.querySelector('[class*="description__text"]')?.innerText?.trim() ||
    document.querySelector('article')?.innerText?.trim() ||
    // Last resort: grab all text from the main content column
    document.querySelector('main')?.innerText?.trim()?.slice(0, 12000);

  return { title, company, jd };
}

function scrapeIndeed() {
  const title   = document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"] h1, h1.jobsearch-JobInfoHeader-title')?.innerText?.trim();
  const company = document.querySelector('[data-testid="inlineHeader-companyName"] a, .jobsearch-InlineCompanyRating-companyHeader')?.innerText?.trim();
  const jd      = document.querySelector('#jobDescriptionText, .jobsearch-jobDescriptionText')?.innerText?.trim();
  return { title, company, jd };
}

function scrapeGeneric() {
  // Title: try h1 first, fall back to page title
  const title = document.querySelector('h1')?.innerText?.trim() || document.title;

  // Company: look for common patterns
  const companyEl = document.querySelector('[class*="company"],[class*="employer"],[class*="org-name"],[itemprop="hiringOrganization"]');
  const company   = companyEl?.innerText?.trim() || document.title.split(/\s+[-|at]\s+/i).pop()?.trim() || '';

  // JD: grab largest text block
  const blocks = [...document.querySelectorAll('article, section, main, [class*="description"],[class*="posting"],[class*="details"],[id*="job"],[id*="description"]')]
    .map(el => el.innerText?.trim())
    .filter(t => t && t.length > 300)
    .sort((a, b) => b.length - a.length);

  const jd = blocks[0] || document.body.innerText.slice(0, 12000);
  return { title, company, jd };
}

function scrapeCurrentPage() {
  const host = location.hostname;
  if (host.includes('linkedin.com'))  return scrapeLinkedIn();
  if (host.includes('indeed.com'))    return scrapeIndeed();
  return scrapeGeneric();
}

// ── Form Filler ───────────────────────────────────────────────────────────────

// Simulate real typing so React/Angular/Vue state updates pick it up
function nativeSet(el, value) {
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
    || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  if (nativeInputValueSetter) nativeInputValueSetter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

function nativeSelectSet(el, value) {
  const option = [...el.options].find(o =>
    o.text.toLowerCase().includes(value.toLowerCase()) ||
    o.value.toLowerCase().includes(value.toLowerCase())
  );
  if (option) {
    el.value = option.value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }
}

// Find a field element from a label hint
function findField(labelHint) {
  const hint = labelHint.toLowerCase().trim();

  // 1. Find <label> elements whose text matches
  const labels = [...document.querySelectorAll('label')];
  for (const label of labels) {
    if (label.innerText.toLowerCase().includes(hint)) {
      // Try for= binding
      if (label.htmlFor) {
        const el = document.getElementById(label.htmlFor);
        if (el) return el;
      }
      // Try next sibling input
      const sibling = label.nextElementSibling;
      if (sibling && ['INPUT','TEXTAREA','SELECT'].includes(sibling.tagName)) return sibling;
      // Try child input
      const child = label.querySelector('input, textarea, select');
      if (child) return child;
    }
  }

  // 2. Find by placeholder
  const byPlaceholder = document.querySelector(`input[placeholder*="${labelHint}" i], textarea[placeholder*="${labelHint}" i]`);
  if (byPlaceholder) return byPlaceholder;

  // 3. Find by name or id attribute
  const byAttr = document.querySelector(`input[name*="${hint}" i], input[id*="${hint}" i], textarea[name*="${hint}" i]`);
  if (byAttr) return byAttr;

  // 4. Find by aria-label
  const byAria = document.querySelector(`[aria-label*="${labelHint}" i]`);
  if (byAria) return byAria;

  return null;
}

function fillFields(fields) {
  const results = [];

  for (const field of fields) {
    if (field.skip) continue;

    const el = findField(field.label);
    if (!el) {
      results.push({ label: field.label, status: 'not_found' });
      continue;
    }

    try {
      if (field.type === 'select' || el.tagName === 'SELECT') {
        nativeSelectSet(el, field.value);
      } else if (field.type === 'checkbox') {
        if (!el.checked) el.click();
      } else if (field.type === 'radio') {
        const radio = document.querySelector(`input[type="radio"][value*="${field.value}" i]`);
        if (radio) radio.click();
      } else if (field.type === 'file') {
        // Can't auto-fill file inputs — highlight it for user
        el.style.outline = '3px solid #6366f1';
        el.style.outlineOffset = '2px';
        results.push({ label: field.label, status: 'highlight_only', note: 'File upload — please upload manually' });
        continue;
      } else {
        el.focus();
        nativeSet(el, field.value);
      }

      // Highlight filled field
      el.style.outline = '2px solid #4ade80';
      el.style.outlineOffset = '2px';
      results.push({ label: field.label, status: 'filled', value: field.value });
    } catch (err) {
      results.push({ label: field.label, status: 'error', error: err.message });
    }
  }

  return results;
}

// Show a toast notification on the page
function showToast(message, type = 'success') {
  const existing = document.getElementById('wingman-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.id = 'wingman-toast';
  toast.style.cssText = `
    position: fixed; bottom: 24px; right: 24px; z-index: 999999;
    background: ${type === 'success' ? '#1a1a2e' : '#1f0d0d'};
    border: 1px solid ${type === 'success' ? '#6366f1' : '#ef4444'};
    color: ${type === 'success' ? '#e8e8ff' : '#fca5a5'};
    padding: 12px 18px; border-radius: 10px;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
    font-size: 13px; font-weight: 500;
    box-shadow: 0 4px 24px rgba(0,0,0,0.4);
    max-width: 320px; line-height: 1.4;
    animation: wingman-slide-in 0.2s ease;
  `;
  toast.innerHTML = `
    <style>@keyframes wingman-slide-in { from { transform: translateY(12px); opacity: 0; } }</style>
    <div style="display:flex;align-items:center;gap:8px">
      <span>${type === 'success' ? '✦' : '⚠'}</span>
      <span>${message}</span>
    </div>
  `;
  document.body.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

// ── Message listener ──────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {

  if (msg.type === 'SCRAPE_JD') {
    try {
      const data = scrapeCurrentPage();
      sendResponse({ ok: true, ...data });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }

  if (msg.type === 'FILL_FORM') {
    try {
      const results = fillFields(msg.fields);
      const filled  = results.filter(r => r.status === 'filled').length;
      const missed  = results.filter(r => r.status === 'not_found').length;
      showToast(`Wingman filled ${filled} field${filled !== 1 ? 's' : ''}${missed > 0 ? ` · ${missed} not found` : ''}`);
      sendResponse({ ok: true, results });
    } catch (err) {
      showToast(err.message, 'error');
      sendResponse({ ok: false, error: err.message });
    }
  }

  return true;
});
