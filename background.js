// background.js — Wingman's brain
// Handles: job queue, Claude API, badge, screenshot+vision form fill

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL_GENERATE = 'claude-sonnet-4-6';       // smart tailoring — 5× cheaper than Opus
const MODEL_EXTRACT  = 'claude-haiku-4-5-20251001'; // dumb extraction — ~20× cheaper than Opus

// ── Badge helper ──────────────────────────────────────────────────────────────
async function updateBadge() {
  const { applications = [] } = await chrome.storage.local.get('applications');
  const ready = applications.filter(a => a.status === 'ready').length;
  const processing = applications.filter(a => a.status === 'processing').length;
  if (ready > 0) {
    chrome.action.setBadgeText({ text: String(ready) });
    chrome.action.setBadgeBackgroundColor({ color: '#6366f1' });
  } else if (processing > 0) {
    chrome.action.setBadgeText({ text: '…' });
    chrome.action.setBadgeBackgroundColor({ color: '#888' });
  } else {
    chrome.action.setBadgeText({ text: '' });
  }
}

// ── Claude API call ───────────────────────────────────────────────────────────
async function callClaude(apiKey, messages, system, maxTokens = 4096, model = MODEL_GENERATE) {
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true'
  };
  // Enable prompt caching when cache_control is used in system or messages
  const hasCacheControl = (Array.isArray(system) && system.some(b => b.cache_control)) ||
    messages.some(m => Array.isArray(m.content) && m.content.some(b => b.cache_control));
  if (hasCacheControl) headers['anthropic-beta'] = 'prompt-caching-2024-07-31';

  const resp = await fetch(CLAUDE_API, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages })
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || `API error ${resp.status}`);
  }
  const data = await resp.json();
  return data.content[0].text;
}

// ── Parse JSON from Claude (strips accidental fences) ────────────────────────
function parseJSON(raw) {
  const clean = raw.replace(/^```[a-z]*\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(clean);
}

// ── Generate targeted resume changes + cover letter ───────────────────────────
async function generateApplication(apiKey, profile, application) {
  const targetPages = profile.target_pages || 1;

  // System prompt cached — identical for every job
  const system = [{
    type: 'text',
    text: `You are a career coach helping optimise resumes for specific job applications.
Return ONLY the minimum targeted changes needed — do NOT rewrite the whole resume.

Return ONLY valid JSON, no markdown fences:
{
  "key_matches": ["5-7 bullets: why this person is a strong fit for this specific role"],
  "cover_letter": "3 short punchy paragraphs. Hook → evidence → close. Never start with 'I am writing to express'.",
  "changes": [
    {
      "section": "section name e.g. Experience",
      "original": "exact verbatim text from the resume to replace",
      "suggested": "improved version using the JD's language and keywords",
      "reason": "one sentence: why this swap helps"
    }
  ],
  "additions": [
    {
      "section": "Skills|Experience|Summary|etc",
      "context": "where to add, e.g. 'under Acme Corp role' or 'end of Skills section'",
      "bullet": "the complete new bullet or line to add",
      "reason": "what JD gap this fills",
      "type": "reframe|new"
    }
  ]
}

Rules:
- Maximum 6 items total across changes + additions — focus on highest ROI only
- "original" must be an exact verbatim substring that appears in the master resume
- Target: ${targetPages} page(s) — keep additions budget tight if already at limit
- Never fabricate company names or job titles`,
    cache_control: { type: 'ephemeral' }
  }];

  // Profile + master resume block — cached, same across all jobs for this user
  const profileBlock = `=== CANDIDATE PROFILE ===
Name: ${profile.name}
Target roles: ${profile.target_roles}
Target pages: ${targetPages}

=== MASTER RESUME ===
${profile.master_resume}`;

  // Job description — NOT cached, changes every call
  const jobBlock = `JOB: ${application.job_title} at ${application.company}

=== JOB DESCRIPTION ===
${application.raw_jd.slice(0, 6000)}`;

  const raw = await callClaude(apiKey, [{
    role: 'user',
    content: [
      { type: 'text', text: profileBlock, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: jobBlock }
    ]
  }], system, 3000, MODEL_GENERATE);
  return parseJSON(raw);
}

// ── Process a single job in the queue ────────────────────────────────────────
async function processJob(jobId) {
  const { applications = [], profile, api_key } = await chrome.storage.local.get([
    'applications', 'profile', 'api_key'
  ]);
  const idx = applications.findIndex(a => a.id === jobId);
  if (idx === -1) return;

  try {
    const result = await generateApplication(api_key, profile, applications[idx]);
    applications[idx] = {
      ...applications[idx],
      status: 'ready',
      cover_letter:  result.cover_letter,
      key_matches:   result.key_matches,
      changes:       result.changes    || [],
      additions:     result.additions  || [],
      processed_at:  Date.now()
    };
  } catch (err) {
    applications[idx] = { ...applications[idx], status: 'error', error: err.message };
  }

  await chrome.storage.local.set({ applications });
  await updateBadge();

  const ready = applications.filter(a => a.status === 'ready').length;
  if (ready > 0) {
    chrome.notifications.create({
      type: 'basic', iconUrl: 'icons/icon48.png', title: 'Wingman',
      message: `${ready} application${ready > 1 ? 's' : ''} ready to review`
    });
  }
}

// ── Message router ────────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    const { api_key, profile } = await chrome.storage.local.get(['api_key', 'profile']);

    // ── Save job from popup ───────────────────────────────────────────────────
    if (msg.type === 'SAVE_JOB') {
      const { applications = [] } = await chrome.storage.local.get('applications');
      const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const newJob = {
        id,
        ...msg.payload,
        status: 'processing',
        saved_at: Date.now()
      };
      applications.push(newJob);
      await chrome.storage.local.set({ applications });
      await updateBadge();
      sendResponse({ ok: true, id });
      // Process async
      processJob(id);
      return;
    }

    // ── Get all applications ──────────────────────────────────────────────────
    if (msg.type === 'GET_APPS') {
      const { applications = [] } = await chrome.storage.local.get('applications');
      sendResponse({ ok: true, applications });
      return;
    }

    // ── Update application (edit, approve, skip, apply) ───────────────────────
    if (msg.type === 'UPDATE_APP') {
      const { applications = [] } = await chrome.storage.local.get('applications');
      const idx = applications.findIndex(a => a.id === msg.id);
      if (idx !== -1) {
        applications[idx] = { ...applications[idx], ...msg.updates };
        await chrome.storage.local.set({ applications });
        await updateBadge();
      }
      sendResponse({ ok: true });
      return;
    }

    // ── Delete application ────────────────────────────────────────────────────
    if (msg.type === 'DELETE_APP') {
      const { applications = [] } = await chrome.storage.local.get('applications');
      const filtered = applications.filter(a => a.id !== msg.id);
      await chrome.storage.local.set({ applications: filtered });
      await updateBadge();
      sendResponse({ ok: true });
      return;
    }

    // ── Retry failed job ──────────────────────────────────────────────────────
    if (msg.type === 'RETRY_JOB') {
      const { applications = [] } = await chrome.storage.local.get('applications');
      const idx = applications.findIndex(a => a.id === msg.id);
      if (idx !== -1) {
        applications[idx].status = 'processing';
        delete applications[idx].error;
        await chrome.storage.local.set({ applications });
        await updateBadge();
        sendResponse({ ok: true });
        processJob(msg.id);
      }
      return;
    }

    // ── Save profile ──────────────────────────────────────────────────────────
    if (msg.type === 'SAVE_PROFILE') {
      await chrome.storage.local.set({
        profile: msg.profile,
        api_key: msg.api_key,
        onboarded: true
      });
      sendResponse({ ok: true });
      return;
    }

    // ── Extract LinkedIn profile ──────────────────────────────────────────────
    if (msg.type === 'EXTRACT_LINKEDIN') {
      try {
        const system = `Extract a structured resume from this LinkedIn profile text.
Return ONLY valid JSON:
{
  "name": "",
  "headline": "",
  "summary": "",
  "experience": [{"title":"","company":"","duration":"","description":""}],
  "education": [{"degree":"","school":"","year":""}],
  "skills": [],
  "master_resume": "Full plain-text resume formatted professionally"
}`;
        const raw = await callClaude(api_key, [
          { role: 'user', content: msg.linkedinText }
        ], system, 4000, MODEL_EXTRACT);
        sendResponse({ ok: true, data: parseJSON(raw) });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Extract resume from PDF (base64) ────────────────────────────────────────
    if (msg.type === 'EXTRACT_RESUME_PDF') {
      try {
        const system = `Extract every detail from this PDF resume. Copy content verbatim — do NOT summarise, shorten, or rewrite anything.

Return ONLY valid JSON with no markdown fences:
{
  "name": "full name",
  "email": "email address or empty string",
  "phone": "phone number or empty string",
  "linkedin": "linkedin URL or empty string",
  "location": "city/country or empty string",
  "master_resume": "the COMPLETE resume as plain text. Preserve every section heading, every bullet point word-for-word, all dates, company names, job titles, metrics, and technologies. Do not skip or compress anything."
}`;
        const raw = await callClaude(api_key, [
          { role: 'user', content: [
            { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: msg.base64 } },
            { type: 'text', text: 'Extract this resume in full. Reproduce every bullet point and section exactly.' }
          ]}
        ], system, 4000, MODEL_EXTRACT);
        sendResponse({ ok: true, data: parseJSON(raw) });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    // ── Extract resume from PDF text ──────────────────────────────────────────
    if (msg.type === 'EXTRACT_RESUME') {
      try {
        const system = `Extract every detail from this resume. Copy content verbatim — do NOT summarise, shorten, or rewrite anything.

Return ONLY valid JSON with no markdown fences:
{
  "name": "full name",
  "email": "email address or empty string",
  "phone": "phone number or empty string",
  "linkedin": "linkedin URL or empty string",
  "location": "city/country or empty string",
  "master_resume": "the COMPLETE resume as plain text. Preserve every section heading, every bullet point word-for-word, all dates, company names, job titles, metrics, and technologies. Do not skip or compress anything."
}`;
        const raw = await callClaude(api_key, [
          { role: 'user', content: msg.resumeText }
        ], system, 4000, MODEL_EXTRACT);
        sendResponse({ ok: true, data: parseJSON(raw) });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message type' });
  })();
  return true;
});

// ── On install → open onboarding ─────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    // Only force onboarding if no profile saved yet
    const { onboarded } = await chrome.storage.local.get('onboarded');
    if (!onboarded) {
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }
  }
  await updateBadge();
});
