// content.js — JD scraping only

function scrapeLinkedIn() {
  const title =
    document.querySelector('h1.t-24')?.innerText?.trim() ||
    document.querySelector('h1[class*="job-title"]')?.innerText?.trim() ||
    document.querySelector('.job-details-jobs-unified-top-card__job-title h1')?.innerText?.trim() ||
    document.querySelector('h1')?.innerText?.trim();

  const company =
    document.querySelector('.job-details-jobs-unified-top-card__company-name a')?.innerText?.trim() ||
    document.querySelector('[class*="company-name"] a')?.innerText?.trim() ||
    document.querySelector('[class*="company-name"]')?.innerText?.trim() ||
    document.querySelector('.topcard__org-name-link')?.innerText?.trim();

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
  const title   = document.querySelector('[data-testid="jobsearch-JobInfoHeader-title"] h1, h1.jobsearch-JobInfoHeader-title')?.innerText?.trim();
  const company = document.querySelector('[data-testid="inlineHeader-companyName"] a, .jobsearch-InlineCompanyRating-companyHeader')?.innerText?.trim();
  const jd      = document.querySelector('#jobDescriptionText, .jobsearch-jobDescriptionText')?.innerText?.trim();
  return { title, company, jd };
}

function scrapeGeneric() {
  const title = document.querySelector('h1')?.innerText?.trim() || document.title;
  const companyEl = document.querySelector('[class*="company"],[class*="employer"],[class*="org-name"],[itemprop="hiringOrganization"]');
  const company   = companyEl?.innerText?.trim() || document.title.split(/\s+[-|at]\s+/i).pop()?.trim() || '';
  const blocks = [...document.querySelectorAll('article, section, main, [class*="description"],[class*="posting"],[class*="details"],[id*="job"],[id*="description"]')]
    .map(el => el.innerText?.trim())
    .filter(t => t && t.length > 300)
    .sort((a, b) => b.length - a.length);
  const jd = blocks[0] || document.body.innerText.slice(0, 12000);
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
