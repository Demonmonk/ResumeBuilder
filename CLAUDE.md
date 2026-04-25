# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Wingman** — a Chrome Extension (Manifest V3) that scrapes job postings, calls the Claude API to tailor a user's resume and generate a cover letter, presents a diff-based review UI, and downloads the result as a format-preserved Word doc or PDF. No backend, no build step, no NPM.

## File Map

| File | Role |
|------|------|
| `manifest.json` | MV3 config — permissions, content scripts, service worker declaration |
| `background.js` | Service worker — message router, Claude API calls, job queue, badge updates |
| `content.js` | Content script — scrapes JD text from LinkedIn/Indeed/generic pages |
| `popup.js/html` | Toolbar popup — job detection, "Save this job" button, stats |
| `onboarding.js/html` | 4-step setup — API key → resume upload → profile → done |
| `dashboard.js/html` | Main UI — job list, diff review, cover letter editor, downloads |
| `docx-editor.js` | ZIP+XML surgery — unzips DOCX, patches `document.xml`, re-zips with CRC32 |

## Tech Stack

- **Vanilla JS / HTML / CSS** — no frameworks, no build step, no npm
- **Chrome Extension APIs** — `chrome.storage.local`, `chrome.runtime.sendMessage`, `chrome.action`, `chrome.notifications`
- **Claude API** — two models:
  - `claude-sonnet-4-6` (`MODEL_GENERATE`) — resume tailoring and cover letter
  - `claude-haiku-4-5-20251001` (`MODEL_EXTRACT`) — PDF/resume extraction
- **Prompt caching** — `cache_control: {type: 'ephemeral'}` on system prompt + profile block; auto-adds `anthropic-beta: prompt-caching-2024-07-31` header
- **Native DOCX** — `DecompressionStream`/`CompressionStream` (no ZIP libraries); direct XML string manipulation

## Development

No build step. Load unpacked at `chrome://extensions` with developer mode on. Changes to JS/HTML take effect on extension reload.

There are no tests or linting configured. Manual testing in-browser is the only test strategy.

## Key Data Structures

**`chrome.storage.local`** holds everything:
```
{ onboarded, api_key, profile: { master_resume, master_resume_docx (base64), target_pages, ... }, applications: [...] }
```

Each application has:
```
{ id, job_title, company, url, raw_jd, status, cover_letter, key_matches, changes[], additions[], token_estimate, token_usage, actual_cost_usd }
```

`status` values: `processing → ready → approved → applied` (also `error`, `skipped`).

## Main Flows

**Save a job:**
```
User clicks "Save this job" in popup
→ popup.js sends SCRAPE_JD → content.js returns {title, company, jd}
→ popup.js sends SAVE_JOB → background.js stores app (status=processing), queues processJob()
→ processJob() calls generateApplication() → Claude Sonnet returns {key_matches, cover_letter, changes, additions}
→ app updated to status=ready; badge count updates; notification fires
```

**Review & download:**
```
dashboard.js loads → GET_APPS from storage → renders list
User clicks job → renderDetail() shows tabs: Matches / Resume diff / Cover letter / JD
User toggles checkboxes (acceptedChanges / acceptedAdditions Maps, in-memory only)
User clicks Download Word → applyChangesToDocx(base64, changes, additions) in docx-editor.js
  → unzip → patch document.xml → re-zip → trigger download
```

**Reactive updates:**
```
background.js calls emitAppsUpdated() after any mutation
→ broadcasts APPS_UPDATED message
→ dashboard.js queueRefresh() debounces 120ms → re-renders list
```

**Cover letter regeneration:**
```
User types note → clicks "Regenerate"
→ dashboard.js sends REGEN_COVER message to background.js
→ background.js calls callClaude() → returns {text, usage} object
→ sendResponse({ ok: true, cover_letter: resp.text })   ← must be resp.text, not resp
→ dashboard.js updates textarea + saves to storage
```

## Gotchas

**`callClaude()` returns `{text, usage}`, not a string.** All callers must use `raw.text` / `resp.text`. This was changed by a Codex refactor — the most common bug is accidentally treating the return value as a string.

**DOCX change matching requires exact substring.** The `original` field in each change must match a verbatim substring of `master_resume`. If the user edits their resume text manually after onboarding, changes may silently fail to apply.

**`acceptedChanges` / `acceptedAdditions` are in-memory Maps.** They must be explicitly cleaned up on `deleteJob()` (`acceptedChanges.delete(id)`) to avoid memory leaks. State is lost on dashboard tab close — by design.

**No DOCX = fallback to RTF.** Format-preserved Word download only works if `profile.master_resume_docx` (base64) is present. If absent, the code falls back to RTF (`.doc`) which loses formatting.

**JD truncation:** raw JDs are truncated to 6000 chars for generation; cover letter regen uses only 2000 chars.

**Prompt caching requires the cached blocks to be identical.** System prompt and profile block are cached. The job-specific block must come last (not cached). Changing the system prompt wording busts the cache for all subsequent calls.

**Duplicate detection:** `SAVE_JOB` computes `simpleHash(normalizeForSignature(app))` and skips re-saving the same job within 30 days.

**No form auto-fill** — code references `FILL_FORM` and vision support exists in `callClaude`, but the flow is not wired up.
