# Wingman — CLAUDE.md

Chrome extension (Manifest V3). AI-powered job application pipeline.
No build step. No npm. Load unpacked directly from this folder.

---

## File map

| File | Role |
|------|------|
| `manifest.json` | MV3 config: permissions, side panel, content scripts |
| `background.js` | Service worker — job queue, Claude API calls, badge, storage |
| `content.js` | Content script — scrapes JD from LinkedIn / Indeed / generic pages |
| `popup.html/js` | Extension popup — detects current page, saves job to queue |
| `dashboard.html/js` | Side panel — review UI: list, detail tabs, accept/reject changes, exports |
| `onboarding.html/js` | Setup wizard — API key → resume upload → profile |
| `docx-editor.js` | Client-side DOCX ZIP+XML surgery (no external lib) |
| `icons/` | icon16/48/128.png required by manifest |

---

## Data flow

```
Job page → content.js (SCRAPE_JD) → popup.js (SAVE_JOB msg)
  → background.js stores job, calls Claude (Sonnet) → status=ready
  → dashboard.js renders review UI
  → user accepts changes → downloadResume() builds final resume
```

---

## Storage schema (`chrome.storage.local`)

```
api_key            string        Anthropic API key
onboarded          boolean
profile            {
  name, email, phone, linkedin,
  target_roles, target_locations,
  target_pages (int),
  master_resume (plain text),
  master_resume_docx (base64, optional — enables format-preserving .docx)
}
applications       Application[]
```

### Application object

```
id                 "job_<ts>_<rand>"
job_title, company, url
raw_jd             full job description text
signature          simpleHash for dedup (30-day window)
status             processing | ready | approved | applied | skipped | error
saved_at           epoch ms
processed_at       epoch ms
cover_letter       string
key_matches        string[]
changes            [{section, original, suggested, reason}]
additions          [{section, context, bullet, reason, type:"reframe"|"new"}]
token_estimate     {input_tokens, output_tokens, estimated_cost_usd}
token_usage        raw usage from Claude response
actual_cost_usd    computed from real token counts
error              string (status=error only)
```

---

## Models

| Constant | Model | Used for |
|----------|-------|----------|
| `MODEL_EXTRACT` | `claude-haiku-4-5-20251001` | Resume/LinkedIn extraction, API key test |
| `MODEL_GENERATE` | `claude-sonnet-4-6` | Full resume + cover letter generation |

Prompt caching is enabled on the system prompt and profile block (ephemeral cache_control).

---

## Message bus (`chrome.runtime.sendMessage`)

| type | direction | payload |
|------|-----------|---------|
| `SAVE_JOB` | popup/content → bg | `{ payload: {job_title, company, url, raw_jd} }` |
| `GET_APPS` | dashboard → bg | — |
| `UPDATE_APP` | dashboard → bg | `{ id, updates: {...} }` |
| `DELETE_APP` | dashboard → bg | `{ id }` |
| `RETRY_JOB` | dashboard → bg | `{ id }` |
| `SAVE_PROFILE` | onboarding → bg | `{ profile, api_key }` |
| `EXTRACT_RESUME` | onboarding → bg | `{ resumeText }` |
| `EXTRACT_RESUME_PDF` | onboarding → bg | `{ base64 }` |
| `EXTRACT_LINKEDIN` | onboarding → bg | `{ linkedinText }` |
| `APPS_UPDATED` | bg → dashboard | broadcast |

---

## Key behaviours

### Duplicate detection
`simpleHash(normalizeForSignature(job))` across title+company+url+jd-prefix.
Jobs with the same signature saved within 30 days are rejected as duplicates.

### Resume change application (`buildFinalResume`)
1. Start from `profile.master_resume` (plain text)
2. Apply accepted `changes` via string `.replace(original, suggested)`
3. Append accepted `additions` bullets, inserted after the section header when found
4. Result is used for PDF (print window) and RTF (.doc fallback)

### Format-preserving DOCX export (`docx-editor.js`)
- Unzips the stored base64 DOCX (DecompressionStream, no deps)
- Finds paragraphs by `<w:p>` tags; matches text via `<w:t>` content
- Applies changes by replacing text in-place (preserving all run formatting)
- Inserts additions by cloning a nearby paragraph's XML as template
- Re-zips (CompressionStream) and triggers download

### Page estimate
`text.length / 3000` ≈ pages. Recalculated live as user checks/unchecks items.

---

## Onboarding flow

Step 0 → Step 1 (API key — tested live) → Step 2 (resume: paste / PDF / DOCX / LinkedIn URL) → Step 3 (profile fields) → Done

`savedApiKey` module variable holds the key for the session; `finish()` falls back to the stored key if the user re-visits onboarding without re-entering it (prevents wiping a valid key).

---

## Adding features — notes

- **New Claude message type**: add handler in `background.js` `onMessage`, add call site, handle response.
- **New dashboard action**: add `data-action="..."` to button HTML, add `if (action === '...')` in the delegated click handler.
- **New export format**: add button in `downloadButtons()`, add branch in `downloadResume()`.
- **New job board scraper**: add `scrapeX()` in `content.js`, add `host.includes(...)` branch in the `SCRAPE_JD` handler.

---

## Common gotchas

- Service workers (background.js) can be terminated between jobs. Long-running `processJob` calls should be idempotent — status is set to `error` on failure, user can retry.
- `changes[].original` must be an exact verbatim substring of `master_resume` — the Claude prompt enforces this, but if it hallucinates a near-miss, `text.replace()` silently does nothing.
- DOCX extraction via `extractDocxText` is used only client-side during onboarding; the resulting plain text is what Claude sees during generation.
- `anthropic-dangerous-direct-browser-access: true` header is required for direct browser-to-API calls (both in background.js and the inline fetch in `regenerateCover`).
- Re-opening onboarding overwrites the profile. The api_key is preserved from storage if `savedApiKey` is empty.
