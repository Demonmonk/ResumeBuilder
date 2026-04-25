# Wingman ✦

Wingman is an AI-powered Chrome extension for high-volume job applications.
It lets you save jobs while browsing, generates targeted resume/cover-letter updates in the background, and keeps everything in a review pipeline before you apply.

---

## What it does today

- **Save jobs in one click** from LinkedIn, Indeed, and generic job pages.
- **Background AI tailoring** using Claude:
  - key-match bullets,
  - resume change suggestions,
  - optional new bullet additions,
  - tailored cover letter draft.
- **Review workflow in a Side Panel** (same browser window):
  - Processing → Ready → Approved → Applied.
- **Selective edits**: accept/reject each suggested resume change.
- **Cost & token telemetry**: per-job estimated token/cost footprint.
- **Resume exports**:
  - PDF,
  - Word (.docx when source DOCX exists, with format-preserving edits),
  - original uploaded `.docx` download for fidelity verification,
  - .doc fallback when no source DOCX exists.
- **Profile backup/restore** (including API key + profile data).

---

## Core product philosophy

1. **Reduce friction** (minimal context switching while job hunting).
2. **Keep user in control** (human approval before final assets).
3. **Be token-smart** (control costs without sacrificing output quality).

---

## Architecture

- **Chrome Extension (Manifest V3)**
  - `background.js`: queue orchestration, Claude calls, storage updates, dedupe, token estimation.
  - `content.js`: job description scraping.
  - `popup.html/js`: quick capture + open review panel.
  - `dashboard.html/js`: review panel UI and exports.
  - `onboarding.html/js`: setup + resume ingestion + profile.
  - `docx-editor.js`: client-side DOCX zip/XML editing for format-preserving updates.

- **Storage model**
  - `chrome.storage.local` only.
  - No remote app server required.

---

## Token/cost strategy

- Extraction runs on a cheaper model.
- Generation runs on a higher-quality model.
- Prompt caching enabled where possible.
- Full captured job descriptions are sent for generation (quality-first).
- Duplicate jobs are detected and skipped.
- Per-job token/cost estimates surfaced in UI.

> Note: Claude pricing changes over time. Any displayed cost values are estimates.

---

## Setup

1. Clone this repo.
2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked** and select this folder.
5. Complete onboarding:
   - Anthropic API key
   - Resume source (paste / PDF / DOCX / LinkedIn)
   - Profile details

---

## Security and privacy notes

- API key is stored in local extension storage on the user’s machine.
- Resume/profile/job data are stored locally.
- Extension needs broad host access to scrape job pages and operate across sites.

---

## Limitations

- Job-page scraping is heuristic and can vary by site layout changes.
- Format-preserving edit mode requires an uploaded `.docx` source (legacy `.doc` is not supported for true format preservation).
- Cost telemetry is approximate unless token usage is returned by provider APIs.

---

## Near-term roadmap

- Improve extraction confidence scoring before expensive generation.
- Add better “already applied / duplicate role” UX hints.
- Expand ATS-style scoring and role-fit analytics.
- Harden model fallbacks and timeout handling.

