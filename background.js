// background.js — Wingman's brain
// Handles: job queue, Claude API, badge, extraction, cost controls

const CLAUDE_API = 'https://api.anthropic.com/v1/messages';
const MODEL_GENERATE = 'claude-sonnet-4-6';
const MODEL_EXTRACT = 'claude-haiku-4-5-20251001';

// Cost controls + rough telemetry (token pricing can change at provider side)
const AVG_CHARS_PER_TOKEN = 4;
const PRICE_PER_M_INPUT = 3.0;   // Sonnet-ish estimate
const PRICE_PER_M_OUTPUT = 15.0; // Sonnet-ish estimate
const MAX_QUEUE_DUP_WINDOW_DAYS = 30;

function approxTokens(text = '') {
  return Math.ceil(String(text).length / AVG_CHARS_PER_TOKEN);
}

function normalizeJobDescription(text = '') {
  return String(text || '').replace(/\r/g, '').trim();
}

function normalizeForSignature(app) {
  return [
    (app.job_title || '').toLowerCase().trim(),
    (app.company || '').toLowerCase().trim(),
    (app.url || '').replace(/\?.*$/, '').toLowerCase(),
    normalizeJobDescription(app.raw_jd || '').slice(0, 12000).toLowerCase()
  ].join('|').replace(/\s+/g, ' ');
}

function simpleHash(str) {
  let hash = 2166136261;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
  }
  return (hash >>> 0).toString(16);
}

function estimateCostUsd(inputTokens, outputTokens) {
  const inputCost = (inputTokens / 1_000_000) * PRICE_PER_M_INPUT;
  const outputCost = (outputTokens / 1_000_000) * PRICE_PER_M_OUTPUT;
  return +(inputCost + outputCost).toFixed(4);
}

async function emitAppsUpdated() {
  try {
    await chrome.runtime.sendMessage({ type: 'APPS_UPDATED' });
  } catch (_) {
    // no listener open (fine)
  }
}

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
  return {
    text: data?.content?.[0]?.text || '',
    usage: data?.usage || null
  };
}

function parseJSON(raw) {
  const clean = raw.replace(/^```[a-z]*\n?/m, '').replace(/\n?```$/m, '').trim();
  return JSON.parse(clean);
}

async function generateApplication(apiKey, profile, application) {
  const targetPages = profile.target_pages || 1;
  const fullJd = normalizeJobDescription(application.raw_jd || '');

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

  const profileBlock = `=== CANDIDATE PROFILE ===\nName: ${profile.name}\nTarget roles: ${profile.target_roles}\nTarget pages: ${targetPages}\n\n=== MASTER RESUME ===\n${profile.master_resume}`;

  const jobBlock = `JOB: ${application.job_title} at ${application.company}\n\n=== JOB DESCRIPTION ===\n${fullJd}`;

  const inputTokensEstimate = approxTokens(profileBlock) + approxTokens(jobBlock) + 650;

  const resp = await callClaude(apiKey, [{
    role: 'user',
    content: [
      { type: 'text', text: profileBlock, cache_control: { type: 'ephemeral' } },
      { type: 'text', text: jobBlock }
    ]
  }], system, 3000, MODEL_GENERATE);

  const parsed = parseJSON(resp.text);
  const outputTokensEstimate = approxTokens(resp.text);

  return {
    data: parsed,
    usage: resp.usage,
    estimate: {
      input_tokens: inputTokensEstimate,
      output_tokens: outputTokensEstimate,
      estimated_cost_usd: estimateCostUsd(inputTokensEstimate, outputTokensEstimate)
    }
  };
}

async function processJob(jobId) {
  const { applications = [], profile, api_key } = await chrome.storage.local.get([
    'applications', 'profile', 'api_key'
  ]);

  const idx = applications.findIndex(a => a.id === jobId);
  if (idx === -1) return;

  try {
    const result = await generateApplication(api_key, profile, applications[idx]);
    const usage = result.usage || {};

    applications[idx] = {
      ...applications[idx],
      status: 'ready',
      cover_letter: result.data.cover_letter,
      key_matches: result.data.key_matches,
      changes: result.data.changes || [],
      additions: result.data.additions || [],
      processed_at: Date.now(),
      token_estimate: result.estimate,
      token_usage: usage,
      actual_cost_usd: usage.input_tokens != null && usage.output_tokens != null
        ? estimateCostUsd(usage.input_tokens, usage.output_tokens)
        : null
    };
  } catch (err) {
    applications[idx] = { ...applications[idx], status: 'error', error: err.message };
  }

  await chrome.storage.local.set({ applications });
  await updateBadge();
  await emitAppsUpdated();

  const ready = applications.filter(a => a.status === 'ready').length;
  if (ready > 0) {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon48.png',
      title: 'Wingman',
      message: `${ready} application${ready > 1 ? 's' : ''} ready to review`
    });
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    const { api_key } = await chrome.storage.local.get(['api_key']);

    if (msg.type === 'SAVE_JOB') {
      const { applications = [] } = await chrome.storage.local.get('applications');
      const payload = { ...msg.payload, raw_jd: normalizeJobDescription(msg.payload?.raw_jd || '') };

      const signature = simpleHash(normalizeForSignature(payload));
      const cutoff = Date.now() - MAX_QUEUE_DUP_WINDOW_DAYS * 24 * 60 * 60 * 1000;
      const existing = applications.find(a => a.signature === signature && (a.saved_at || 0) > cutoff);
      if (existing) {
        sendResponse({ ok: true, id: existing.id, duplicate: true });
        return;
      }

      const id = `job_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const newJob = {
        id,
        ...payload,
        signature,
        status: 'processing',
        saved_at: Date.now(),
        token_estimate: {
          input_tokens: approxTokens(payload.raw_jd) + 800,
          output_tokens: 0,
          estimated_cost_usd: estimateCostUsd(approxTokens(payload.raw_jd) + 800, 0)
        }
      };

      applications.push(newJob);
      await chrome.storage.local.set({ applications });
      await updateBadge();
      await emitAppsUpdated();
      sendResponse({ ok: true, id, duplicate: false });
      processJob(id);
      return;
    }

    if (msg.type === 'GET_APPS') {
      const { applications = [] } = await chrome.storage.local.get('applications');
      sendResponse({ ok: true, applications });
      return;
    }

    if (msg.type === 'UPDATE_APP') {
      const { applications = [] } = await chrome.storage.local.get('applications');
      const idx = applications.findIndex(a => a.id === msg.id);
      if (idx !== -1) {
        applications[idx] = { ...applications[idx], ...msg.updates };
        await chrome.storage.local.set({ applications });
        await updateBadge();
        await emitAppsUpdated();
      }
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'DELETE_APP') {
      const { applications = [] } = await chrome.storage.local.get('applications');
      const filtered = applications.filter(a => a.id !== msg.id);
      await chrome.storage.local.set({ applications: filtered });
      await updateBadge();
      await emitAppsUpdated();
      sendResponse({ ok: true });
      return;
    }

    if (msg.type === 'RETRY_JOB') {
      const { applications = [] } = await chrome.storage.local.get('applications');
      const idx = applications.findIndex(a => a.id === msg.id);
      if (idx !== -1) {
        applications[idx].status = 'processing';
        delete applications[idx].error;
        await chrome.storage.local.set({ applications });
        await updateBadge();
        await emitAppsUpdated();
        sendResponse({ ok: true });
        processJob(msg.id);
      }
      return;
    }

    if (msg.type === 'SAVE_PROFILE') {
      await chrome.storage.local.set({
        profile: msg.profile,
        api_key: msg.api_key,
        onboarded: true
      });
      sendResponse({ ok: true });
      return;
    }

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
        sendResponse({ ok: true, data: parseJSON(raw.text) });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

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
          {
            role: 'user', content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: msg.base64 } },
              { type: 'text', text: 'Extract this resume in full. Reproduce every bullet point and section exactly.' }
            ]
          }
        ], system, 4000, MODEL_EXTRACT);
        sendResponse({ ok: true, data: parseJSON(raw.text) });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

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
        sendResponse({ ok: true, data: parseJSON(raw.text) });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
      return;
    }

    sendResponse({ ok: false, error: 'Unknown message type' });
  })();

  return true;
});

chrome.runtime.onInstalled.addListener(async details => {
  if (details.reason === 'install') {
    const { onboarded } = await chrome.storage.local.get('onboarded');
    if (!onboarded) {
      chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    }
  }
  await updateBadge();
});
