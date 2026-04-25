# Wingman ✦

Your AI job application co-pilot. Chrome extension that tailors your resume and cover letter to every job in the background — while you keep browsing.

## What it does

- **Save any job in one click** — scrapes the JD automatically on LinkedIn, Indeed, Greenhouse, Lever, Workday, or any site
- **AI generates tailored resume + cover letter** — runs in background, you keep browsing
- **Resume diff view** — see exactly what changed, edit inline
- **Vision-based form filler** — screenshots the application form, fills every field automatically on any site
- **Application tracker** — Ready → Approved → Applied pipeline

## Stack

- Pure Chrome Extension (Manifest V3)
- Claude API (Opus) for generation + vision form filling
- `chrome.storage` for persistence — no server, no backend, no VPS
- ~$0.03 per job application

## Setup (dev)

1. Clone this repo
2. Go to `chrome://extensions` → Enable Developer mode
3. Click Load unpacked → select this folder
4. Extension opens onboarding automatically

## File structure

```
manifest.json       — MV3 config
background.js       — Service worker: Claude API, job queue, form vision
content.js          — JD scraper + form field filler (runs on every page)
popup.html/js       — The toolbar popup
onboarding.html/js  — First-run setup: API key, resume upload, profile
dashboard.html/js   — Review queue: diff view, cover letter editor, tracker
```

## Cost

Each application = ~$0.03 (Claude Opus via Anthropic API)
100 applications ≈ $3

API key from: console.anthropic.com
