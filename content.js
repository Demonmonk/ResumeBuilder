// content.js — JD scraping only

// Take only the first non-empty line and cap length — prevents multi-line innerText
// from container elements (company name + location + ratings) bloating the title/company fields.
function firstLine(s, max = 120) {
  if (!s) return s;
  return s.split(/[\r\n]+/).map(l => l.trim()).find(l => l.length > 0)?.slice(0, max) || '';
}

function scrapeLinkedIn() {
  const title = firstLine(
    document.querySelector('h1.t-24')?.innerText ||
    document.querySelector('h1[class*="job-title"]')?.innerText ||
    document.querySelector('.job-details-jobs-unified-top-card__job-title h1')?.innerText ||
    document.querySelector('h1')?.innerText
  );

  // Prefer the anchor (just the name) over the container div (name + location + rating)
  const company = firstLine(
    document.querySelector('.job-details-jobs-unified-top-card__company-name a')?.innerText ||
    document.querySelector('[class*="company-name"] a')?.innerText ||
    document.querySelector('.topcard__org-name-link')?.innerText ||
    document.querySelector('[class*="company-name"]')?.innerText,
    100
  );

  const jd =
    document.querySelector('.jobs-description__content')?.innerText?.trim() ||
    document.querySelector('[class*="jobs-description"]')?.innerText?.trim() ||
    document.querySelector('#job-details')?.innerText?.trim() ||
    document.querySelector('[class*="description__text"]')?.innerText?.trim() ||
    document.querySelector('article')?.innerText?.trim() ||
    document.querySelector('main')?.innerText?.trim()?.slice(0, 12000);

  return { title, company, jd };
}

function scrapeIndeed() {
  const title   = firstLine(document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"] h1, h1.jobsearch-JobInfoHeader-title')?.innerText);
  // Prefer the anchor inside the rating header — it contains just the company name
  const company = firstLine(
    document.querySelector('[data-testid="inlineHeader-companyName"] a')?.innerText ||
    document.querySelector('[data-testid="inlineHeader-companyName"]')?.innerText ||
    document.querySelector('.jobsearch-InlineCompanyRating-companyHeader a')?.innerText ||
    document.querySelector('.jobsearch-InlineCompanyRating-companyHeader')?.innerText,
    100
  );
  const jd = document.querySelector('#jobDescriptionText, .jobsearch-jobDescriptionText')?.innerText?.trim();
  return { title, company, jd };
}

function scrapeGeneric() {
  const title = firstLine(document.querySelector('h1')?.innerText) || document.title.slice(0, 120);
  const companyEl = document.querySelector('[class*="company"],[class*="employer"],[class*="org-name"],[itemprop="hiringOrganization"]');
  const company = firstLine(companyEl?.innerText, 100) ||
    firstLine(document.title.split(/\s+[-|at]\s+/i).pop(), 100) || '';
  const blocks = [...document.querySelectorAll('article, section, main, [class*="description"],[class*="posting"],[class*="details"],[id*="job"],[id*="description"]')]
    .map(el => el.innerText?.trim())
    .filter(t => t && t.length > 300)
    .sort((a, b) => b.length - a.length);
  const jd = (blocks[0] || document.body.innerText).slice(0, 12000);
  return { title, company, jd };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'SCRAPE_JD') {
    try {
      const host = location.hostname;
      let data;
      if (host.includes('linkedin.com')) data = scrapeLinkedIn();
      else if (host.includes('indeed.com')) data = scrapeIndeed();
      else data = scrapeGeneric();
      sendResponse({ ok: true, ...data });
    } catch (err) {
      sendResponse({ ok: false, error: err.message });
    }
  }
  return true;
});
