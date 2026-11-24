const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];

let timer = null;
let missionPaused = false;
let pendingMissionPrompt = '';
let liveAnswer = '';
let liveSources = [];
let liveError = '';
let liveHasAnswer = false;
let liveIsDemo = false;
let liveAnswerKind = 'Keyless web answer';
let liveAnswerDescription = 'Keyless instant answer and related references.';
let activeHistoryId = null;

function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML.replace(/\n/g, '<br>');
}

function cleanSearchText(value) {
  return typeof value === 'string'
    ? value.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim()
    : '';
}

function safeSearchUrl(value) {
  if (typeof value !== 'string') return '';
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : '';
  } catch {
    return '';
  }
}

function collectRelatedTopics(topics) {
  const results = [];
  const pending = Array.isArray(topics) ? [...topics] : [];
  while (pending.length && results.length < 5) {
    const topic = pending.shift();
    if (!topic || typeof topic !== 'object') continue;
    if (Array.isArray(topic.Topics)) pending.unshift(...topic.Topics);
    const title = cleanSearchText(topic.Text);
    const url = safeSearchUrl(topic.FirstURL);
    if (title && url) results.push({ title, url });
  }
  return results;
}

function addSearchSource(sources, title, rawUrl) {
  const url = safeSearchUrl(rawUrl);
  if (!url || sources.some(source => source.url === url)) return;
  sources.push({ title: cleanSearchText(title) || new URL(url).hostname, url });
}

function requestJsonp(url) {
  return new Promise((resolve, reject) => {
    const callbackName = `benetSearch_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const script = document.createElement('script');
    let timeout;
    const cleanup = () => {
      clearTimeout(timeout);
      delete globalThis[callbackName];
      script.remove();
    };

    globalThis[callbackName] = data => {
      cleanup();
      resolve(data);
    };
    script.async = true;
    script.onerror = () => {
      cleanup();
      reject(new Error('Could not load a web answer. Please retry or open full search.'));
    };
    timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Web lookup timed out.'));
    }, 10000);

    const requestUrl = new URL(url);
    requestUrl.searchParams.set('callback', callbackName);
    script.src = requestUrl.href;
    document.head.appendChild(script);
  });
}

function requestDuckDuckGoAnswer(prompt) {
  const url = new URL('https://api.duckduckgo.com/');
  url.search = new URLSearchParams({
    q: prompt,
    format: 'json',
    no_html: '1',
    skip_disambig: '1'
  }).toString();
  return requestJsonp(url.href);
}

function simplifyWikipediaQuery(prompt) {
  return prompt
    .replace(/^\s*(?:please\s+)?(?:what|who|where|when|why|how)\s+(?:is|are|was|were|does|do|did|can|could|should|would)\s+/i, '')
    .replace(/^\s*(?:explain|describe|define|summarize|tell me about)\s+/i, '')
    .replace(/\b(?:the|a|an|work|works|happen|happens)\b/gi, ' ')
    .replace(/[?!.,;:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function isTimeSensitiveQuestion(prompt) {
  return /\b(latest|current|today|right now|news|price|prices|cost|available|availability|deadline|weather|forecast|stock|near me)\b/i.test(prompt);
}

async function requestWikipediaSummaries(prompt) {
  const url = new URL('https://en.wikipedia.org/w/api.php');
  url.search = new URLSearchParams({
    action: 'query',
    generator: 'search',
    gsrsearch: simplifyWikipediaQuery(prompt) || prompt,
    gsrlimit: '3',
    prop: 'extracts',
    exintro: '1',
    explaintext: '1',
    exsentences: '3',
    format: 'json',
    origin: '*'
  }).toString();
  const data = await requestJsonp(url.href);
  const pages = Object.values(data?.query?.pages || {}).sort((a, b) => (a.index || 0) - (b.index || 0));

  return pages.map(page => {
    const extract = cleanSearchText(page?.extract);
    if (!page || !extract || !Number.isInteger(page.pageid)) return null;
    return {
      title: cleanSearchText(page.title),
      extract,
      url: `https://en.wikipedia.org/?curid=${page.pageid}`
    };
  }).filter(Boolean);
}

function normalizeExamplePrompt(prompt) {
  return prompt.trim().toLowerCase().replace(/[.!?…]+$/g, '').replace(/\s+/g, ' ');
}

const demoAnswerPresets = new Map([
  ['Plan a 3-day budget trip to Goa with beaches, transport and stays.',
    `SAMPLE ITINERARY · Illustrative only, not live travel data
Day 1 — North Goa: Visit a beach, explore nearby cafés, and catch sunset near Vagator.
Day 2 — Panaji: Walk through Fontainhas, visit the riverside, and try a local market.
Day 3 — South Goa: Choose a quieter beach, leave time for lunch, and return to your stay.
Transport: Compare local buses, app taxis, and scooter rentals; check current availability and safety rules.
Budget idea: Set a sample daily cap for food, local transport, and stays, then verify actual prices before booking.`],
  ['Research the best AI/ML internships for engineering students and organise the requirements.',
    `SAMPLE OPPORTUNITY BRIEF · Fictional examples, no openings or deadlines verified
1. Research internship — prepare a small experiment, a concise project write-up, and Python fundamentals.
2. Machine-learning engineering internship — highlight model evaluation, data handling, and reproducible code.
3. Applied AI internship — show a working prototype, explain limitations, and document responsible use.
Before applying: confirm eligibility, location, stipend, and deadline on each employer’s official careers page.`],
  ['Compare the top 5 noise-cancelling headphones under ₹15,000.',
    `SAMPLE COMPARISON · Illustrative products and prices, not live listings
Compare options by noise cancellation, comfort, battery life, warranty, and return policy.
For this demo, use three fictional profiles: “Quiet Pro” for travel, “Studio Lite” for balanced listening, and “Longplay” for battery life.
Sample recommendation: choose the option that best matches your priority; verify current models, prices, and reviews before buying.`],
  ['What are the latest breakthroughs in battery technology?',
    `SAMPLE RESEARCH NOTE · Not a live update
Common areas to investigate include solid-state designs, sodium-ion chemistry, improved lithium-ion materials, and battery recycling.
When comparing a claimed breakthrough, check whether it has independent test results, a published energy-density figure, cycle-life data, and a credible path to manufacturing.
This sample does not verify which development is newest.`],
  ['Explain the pros and cons of heat pumps for a small home.',
    `SAMPLE EXPLANATION · General demo content, not a home assessment
Potential benefits: efficient heating and cooling, one system for both jobs, and lower operating emissions where electricity is relatively clean.
Trade-offs: upfront installation cost, space and electrical requirements, and performance that depends on climate, insulation, and system design.
For a real decision, compare a qualified installer’s quote with local utility rates and available rebates.`],
  ['Find credible sources about ocean plastic cleanup.',
    `SAMPLE SOURCE-FINDING GUIDE · No sources were checked for this demo
Start with peer-reviewed reviews, government or intergovernmental reports, and transparent project evaluations.
Compare cleanup claims by location, plastic type, measurement method, ecological impact, and whether prevention is included.
Treat headline totals cautiously unless the report explains how collected material was measured and verified.`],
  ['Summarize the newest research on AI tutoring and its impact on student learning.',
    `SAMPLE RESEARCH BRIEF · Not a current literature review
AI tutoring tools may offer practice, hints, and feedback tailored to a learner’s pace. Outcomes depend on instructional design, teacher involvement, and how learning is measured.
Key questions for a real review: Are gains independently evaluated? Do they persist? Which students benefit or are left out? How are privacy and incorrect feedback handled?
The word “newest” requires a live review of current studies.`],
  ['Research current open-source speech recognition tools and compare their strengths.',
    `SAMPLE COMPARISON · Not a current benchmark
For a demo, compare tools on language coverage, transcription quality, latency, offline use, hardware needs, and license.
Whisper-style systems are often considered for broad multilingual transcription; Vosk-style deployments are often evaluated for offline and lower-resource setups. Actual results vary by model, language, and audio.
Run the same representative clips through each candidate before choosing.`],
  ['Find and summarize authoritative guidance for protecting personal data online.',
    `SAMPLE CHECKLIST · Not a substitute for current official guidance
Use unique passwords with a password manager, enable multi-factor authentication, keep software updated, and review app permissions.
Share less personal information publicly, be cautious with unexpected links, and verify important requests through a separate trusted channel.
For account-specific steps, consult the official security guidance from the service or your local data-protection authority.`],
  ['Find the best AI laptops under ₹80,000, compare 5 options, and recommend one for a student...',
    `SAMPLE BUYING GUIDE · Fictional comparison; prices and models are not live
For a student, shortlist five current models and compare processor, RAM, battery life, weight, warranty, and the software you need.
Prefer enough memory for your coursework and a reliable service network over an AI feature you may not use.
Check current prices and configurations from official sellers before deciding.`],
  ['Notion vs. Obsidian for a student',
    `SAMPLE COMPARISON · Illustrative guidance, not a live product review
Notion is a cloud-first workspace that suits shared notes and structured databases. Obsidian stores linked Markdown notes locally and suits personal knowledge graphs.
Sample pick: choose Notion for collaboration and ready-made organization; choose Obsidian for local files and flexible linking.
Check current plans, sync options, and your school’s privacy requirements.`]
].map(([question, answer]) => [normalizeExamplePrompt(question), answer]));

function getDemoAnswer(prompt) {
  const normalized = normalizeExamplePrompt(prompt);
  const exact = demoAnswerPresets.get(normalized);
  if (exact) return exact;
  if (/^compare notion vs\.? obsidian for a student\b/.test(normalized)) {
    return demoAnswerPresets.get(normalizeExamplePrompt('Notion vs. Obsidian for a student'));
  }
  return null;
}

const views = {
  overview: $('#overviewView'),
  agent: $('#agentView'),
  feature: $('#featureView')
};

const featureData = {
  research: { title: 'Research, without the rabbit hole.', desc: 'A focused desk for turning questions into sourced briefs.', stamp: 'RESEARCH DESK · 01' },
  compare: { title: 'Put every option on the same page.', desc: 'A decision workspace built around the trade-offs that matter to you.', stamp: 'DECISION LAB · 02' },
  automate: { title: 'Prepare the work. You approve the action.', desc: 'Build a transparent action plan and keep the final click in human hands.', stamp: 'ACTION STUDIO · 03' },
  saved: { title: 'Your best discoveries, collected.', desc: 'A personal library for answers and decisions worth keeping.', stamp: 'YOUR LIBRARY · 04' },
  history: { title: 'A clear trail of every mission.', desc: 'Review what you asked, what BENET did, and how each run ended.', stamp: 'MISSION LOG · 05' }
};

const workspaceTemplates = {
  research: () => `
    <div class="research-grid">
      <section class="research-console">
        <div class="console-label"><span>01</span> RESEARCH QUESTION</div>
        <h2>What do you want to understand?</h2>
        <p>BENET checks for a keyless instant answer and returns related source links when available.</p>
        <div class="research-input-row"><textarea id="researchPrompt" rows="2" placeholder="Ask a question, investigate a topic, or find the latest..."></textarea><button class="run-btn" id="runResearch">Start research ↗</button></div>
        <div class="research-suggestions"><span>QUICK START</span><button data-research="What are the latest breakthroughs in battery technology?">Latest breakthroughs</button><button data-research="Explain the pros and cons of heat pumps for a small home.">Explain a topic</button><button data-research="Find credible sources about ocean plastic cleanup.">Find sources</button></div>
      </section>
      <aside class="research-rail"><div class="rail-kicker">RESEARCH MODE</div><div class="research-mode"><span class="mode-icon">⌕</span><div><strong>Keyless web lookup</strong><small>Instant answers · source links</small></div><i class="mode-check">✓</i></div><div class="rail-kicker">YOUR BRIEF INCLUDES</div><div class="brief-item"><b>01</b><span>Available DuckDuckGo instant answers</span></div><div class="brief-item"><b>02</b><span>Wikipedia topic summaries when needed</span></div><div class="brief-item"><b>03</b><span>Full web search for current or unsupported questions</span></div><div class="research-note">◎ Queries go to DuckDuckGo and Wikipedia. Search coverage varies; do not include sensitive information.</div></aside>
    </div>
    <section class="research-topics"><div><div class="eyebrow">START WITH A LENS</div><h2>Explore by intent</h2></div><button class="topic-card" data-research="Summarize the newest research on AI tutoring and its impact on student learning."><span>01 / LEARN</span><strong>Explain a complex topic</strong><small>Get a clear overview with sources.</small><i>↗</i></button><button class="topic-card" data-research="Research current open-source speech recognition tools and compare their strengths."><span>02 / INVESTIGATE</span><strong>Follow a developing story</strong><small>Find what changed and why.</small><i>↗</i></button><button class="topic-card" data-research="Find and summarize authoritative guidance for protecting personal data online."><span>03 / VERIFY</span><strong>Check the evidence</strong><small>Trace claims back to useful sources.</small><i>↗</i></button></section>`,
  compare: () => `
    <section class="compare-command"><div><div class="eyebrow">COMPARISON BUILDER</div><h2>What are you deciding between?</h2><p>Enter products, plans, tools, or any two choices. BENET will research the differences.</p></div><div class="compare-form"><input id="comparePrompt" type="text" placeholder="e.g. Notion vs. Obsidian for a student"><button class="run-btn" id="runCompare">Build comparison ↗</button></div></section>
    <div class="compare-workspace"><section class="compare-matrix"><div class="matrix-head"><div><span class="matrix-overline">SAMPLE DECISION MATRIX</span><h2>Wireless headphones</h2></div><div class="matrix-controls"><button class="active" data-matrix-sort="performance">Performance</button><button data-matrix-sort="price">Price</button></div></div><div class="matrix-table" id="matrixTable"></div><div class="matrix-foot"><span>✦ SAMPLE DATA</span> Run your own comparison for fresh web-grounded results.</div></section><aside class="compare-priorities"><div class="eyebrow">YOUR PRIORITIES</div><h3>What matters most?</h3><label><input type="checkbox" checked> Price &amp; value</label><label><input type="checkbox" checked> Performance</label><label><input type="checkbox"> Reviews &amp; reliability</label><label><input type="checkbox"> Sustainability</label><div class="priority-tip">Adjust priorities to frame the recommendation around your needs.</div></aside></div>`,
  automate: () => `
    <div class="action-layout"><section class="action-builder"><div class="action-step-label"><span>STEP 01</span><i></i><span>DEFINE THE OUTCOME</span></div><div class="eyebrow">ACTION REQUEST</div><h2>What should BENET prepare?</h2><textarea id="actionPrompt" rows="2" placeholder="e.g. Prepare my conference registration details"></textarea><div class="action-step-label"><span>STEP 02</span><i></i><span>REVIEW THE PLAN</span></div><div class="action-plan-list"><div><b>1</b><span><strong>Gather the required information</strong><small>BENET will identify fields and prerequisites.</small></span><em>PREPARE</em></div><div><b>2</b><span><strong>Fill a reviewable draft</strong><small>No data will be submitted automatically.</small></span><em>HUMAN CHECK</em></div><div><b>3</b><span><strong>Pause for your approval</strong><small>You can approve, modify, or stop.</small></span><em class="secure-tag">REQUIRED</em></div></div><button class="run-btn" id="runAction">Prepare action plan ↗</button></section><aside class="action-safety"><div class="safety-shield">◈</div><div class="eyebrow">HUMAN CONTROL</div><h3>Nothing submits without you.</h3><p>BENET can organize steps and prepare information. You stay in control of external, sensitive, or irreversible actions.</p><div class="safety-status"><span></span> APPROVAL GATE ENABLED</div><div class="safety-rule">Purchase · submit · send · publish <b>→</b> your decision</div></aside></div>
    <section class="action-recents"><div class="eyebrow">WORKFLOW TEMPLATES</div><h2>Start from a common task</h2><div class="workflow-cards"><button data-action-prompt="Prepare a conference registration form for my event"><span>▤</span><strong>Event registration</strong><small>Gather details, prepare fields, pause for review.</small></button><button data-action-prompt="Prepare a travel booking plan with itinerary and options"><span>↗</span><strong>Travel planning</strong><small>Organize an itinerary before booking.</small></button><button data-action-prompt="Prepare an application form for a student internship"><span>◎</span><strong>Application prep</strong><small>Build a draft and keep final submission manual.</small></button></div></section>`,
  saved: () => `
    <section class="library-toolbar"><div class="library-search"><span>⌕</span><input id="savedSearch" type="search" placeholder="Search your saved discoveries"></div><div class="library-filters"><button class="active" data-saved-filter="all">All</button><button data-saved-filter="research">Research</button><button data-saved-filter="compare">Comparisons</button></div></section><div class="library-summary"><span><strong id="savedCount">0</strong> SAVED ITEMS</span><span>STORED IN THIS BROWSER</span></div><div class="saved-list" id="savedList"></div>`,
  history: () => `
    <section class="history-overview"><div class="history-stat"><span class="stat-icon">↗</span><strong id="historyTotal">0</strong><small>TOTAL MISSIONS</small></div><div class="history-stat"><span class="stat-icon success">✓</span><strong id="historyCompleted">0</strong><small>COMPLETED</small></div><div class="history-stat"><span class="stat-icon pending">◷</span><strong id="historyPending">0</strong><small>NEEDS ATTENTION</small></div><div class="history-privacy">Your activity log stays in this browser.</div></section><section class="history-feed"><div class="feed-head"><div><div class="eyebrow">TIMELINE</div><h2>Mission activity</h2></div><div class="library-filters"><button class="active" data-history-filter="all">All</button><button data-history-filter="completed">Completed</button><button data-history-filter="attention">Needs attention</button></div></div><div id="historyList"></div></section>`
};

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function showView(name) {
  Object.values(views).forEach(v => v.classList.add('hidden'));
  $$('.nav-item').forEach(b => b.classList.toggle('active', b.dataset.view === name));
  $('#pageName').textContent = ({ overview: 'Overview', research: 'Research agent', compare: 'Compare anything', automate: 'Web actions', saved: 'Saved discoveries', history: 'Activity history' }[name] || 'Overview');
  if (name === 'overview') {
    views.overview.classList.remove('hidden');
  } else if (featureData[name]) {
    const d = featureData[name];
    $('#workspaceTitle').textContent = d.title;
    $('#workspaceDesc').textContent = d.desc;
    $('#workspaceStamp').textContent = d.stamp;
    $('#workspaceContent').innerHTML = workspaceTemplates[name]();
    views.feature.classList.remove('hidden');
    setupWorkspace(name);
  }
}

function readLocalItems(key, label) {
  try {
    const items = JSON.parse(localStorage.getItem(key) || '[]');
    return Array.isArray(items) ? items : [];
  } catch {
    toast(`Could not read ${label} saved in this browser.`);
    return [];
  }
}

function writeLocalItems(key, items, label) {
  try {
    localStorage.setItem(key, JSON.stringify(items));
    return true;
  } catch {
    toast(`Could not save ${label}. Check this browser's storage settings.`);
    return false;
  }
}

function runMissionPrompt(prompt) {
  showView('overview');
  $('#prompt').value = prompt;
  startMission();
}

function setupWorkspace(name) {
  if (name === 'research') {
    $('#runResearch').addEventListener('click', () => runMissionPrompt($('#researchPrompt').value.trim()));
    $$('[data-research]').forEach(button => button.addEventListener('click', () => {
      $('#researchPrompt').value = button.dataset.research;
      $('#researchPrompt').focus();
    }));
    $('#researchPrompt').addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        $('#runResearch').click();
      }
    });
  }

  if (name === 'compare') {
    renderComparisonMatrix('performance');
    $('#runCompare').addEventListener('click', () => {
      const options = $('#comparePrompt').value.trim();
      if (options) runMissionPrompt(`Compare ${options}. Focus on ${$$('.compare-priorities input:checked').map(input => input.parentElement.textContent.trim()).join(', ') || 'overall value'} and cite current sources.`);
      else toast('Enter the options or question you want compared.');
    });
    $$('.matrix-controls button').forEach(button => button.addEventListener('click', () => {
      $$('.matrix-controls button').forEach(item => item.classList.toggle('active', item === button));
      renderComparisonMatrix(button.dataset.matrixSort);
    }));
  }

  if (name === 'automate') {
    $('#runAction').addEventListener('click', () => {
      const action = $('#actionPrompt').value.trim();
      if (action) runMissionPrompt(`Prepare a form/action workflow for: ${action}. Do not submit anything; pause for human approval.`);
      else toast('Describe the action you want BENET to prepare.');
    });
    $$('[data-action-prompt]').forEach(button => button.addEventListener('click', () => {
      $('#actionPrompt').value = button.dataset.actionPrompt;
      $('#actionPrompt').focus();
    }));
  }

  if (name === 'saved') setupSavedLibrary();
  if (name === 'history') setupHistoryFeed();
}

function renderComparisonMatrix(sortBy) {
  const options = [
    { name: 'SONY XM5', price: 14900, performance: 94, battery: '30 hours', bestFor: 'Balanced use' },
    { name: 'BOSE QC ULTRA', price: 12999, performance: 91, battery: '24 hours', bestFor: 'Travel comfort' },
    { name: 'SENNHEISER ACCENTUM', price: 13990, performance: 89, battery: '50 hours', bestFor: 'Long battery' }
  ].sort((a, b) => sortBy === 'price' ? a.price - b.price : b.performance - a.performance);
  const topPick = sortBy === 'price'
    ? options.reduce((best, option) => option.price < best.price ? option : best)
    : options.reduce((best, option) => option.performance > best.performance ? option : best);
  const columns = options.map(option => `<div class="matrix-cell${option === topPick ? ' matrix-featured' : ''}">${option.name}${option === topPick ? '<span>BENET PICK</span>' : ''}</div>`).join('');
  $('#matrixTable').innerHTML = `<div class="matrix-cell matrix-label">OPTION</div>${columns}<div class="matrix-cell matrix-label">PRICE</div>${options.map(option => `<div class="matrix-cell">₹${option.price.toLocaleString('en-IN')}</div>`).join('')}<div class="matrix-cell matrix-label">PERFORMANCE</div>${options.map(option => `<div class="matrix-cell">${option.performance}/100</div>`).join('')}<div class="matrix-cell matrix-label">BATTERY</div>${options.map(option => `<div class="matrix-cell">${option.battery}</div>`).join('')}<div class="matrix-cell matrix-label">BEST FOR</div>${options.map(option => `<div class="matrix-cell">${option.bestFor}</div>`).join('')}`;
}

function setupSavedLibrary() {
  const filter = { type: 'all', query: '' };
  const render = () => {
    const items = readLocalItems('benet-saved-discoveries', 'saved discoveries');
    $('#savedCount').textContent = String(items.length);
    const matched = items.filter(item => (filter.type === 'all' || item.type === filter.type) &&
      `${item.prompt} ${item.answer}`.toLowerCase().includes(filter.query.toLowerCase()));
    $('#savedList').innerHTML = matched.length
      ? matched.map(item => `<article class="saved-card"><div class="saved-card-meta"><span>${item.type === 'compare' ? '⇄ COMPARISON' : '⌕ RESEARCH'}</span><time>${new Date(item.savedAt).toLocaleDateString()}</time></div><h2>${escapeHtml(item.prompt)}</h2><p>${escapeHtml(item.answer.slice(0, 360))}${item.answer.length > 360 ? '…' : ''}</p><div class="saved-card-actions"><button data-open-saved="${item.id}">Run again ↗</button><button data-remove-saved="${item.id}">Remove</button></div></article>`).join('')
      : `<div class="library-empty"><span>▤</span><h2>${items.length ? 'No discoveries match that filter.' : 'Your library is ready.'}</h2><p>${items.length ? 'Try another search or category.' : 'When a live BENET answer is useful, choose “Save to discoveries” and it will appear here.'}</p></div>`;
    $$('[data-open-saved]').forEach(button => button.addEventListener('click', () => {
      const item = items.find(entry => String(entry.id) === button.dataset.openSaved);
      if (item) runMissionPrompt(item.prompt);
    }));
    $$('[data-remove-saved]').forEach(button => button.addEventListener('click', () => {
      writeLocalItems('benet-saved-discoveries', items.filter(entry => String(entry.id) !== button.dataset.removeSaved), 'discovery');
      render();
    }));
  };
  $('#savedSearch').addEventListener('input', event => { filter.query = event.target.value; render(); });
  $$('[data-saved-filter]').forEach(button => button.addEventListener('click', () => {
    filter.type = button.dataset.savedFilter;
    $$('[data-saved-filter]').forEach(item => item.classList.toggle('active', item === button));
    render();
  }));
  render();
}

function setupHistoryFeed() {
  let filter = 'all';
  const render = () => {
    const items = readLocalItems('benet-mission-history', 'mission history').sort((a, b) => b.createdAt - a.createdAt);
    const completed = items.filter(item => item.status === 'completed').length;
    const pending = items.filter(item => item.status === 'attention').length;
    $('#historyTotal').textContent = String(items.length);
    $('#historyCompleted').textContent = String(completed);
    $('#historyPending').textContent = String(pending);
    const visible = items.filter(item => filter === 'all' || item.status === filter);
    $('#historyList').innerHTML = visible.length
      ? visible.map(item => `<article class="history-entry"><div class="history-time">${new Date(item.createdAt).toLocaleString()}</div><span class="history-dot ${item.status.replace(/\s+/g, '-')}"></span><div class="history-entry-main"><div><span class="history-type">${item.type}</span><span class="history-status ${item.status.replace(/\s+/g, '-')}">${item.status === 'completed' ? 'COMPLETE' : item.status === 'attention' ? 'NEEDS ATTENTION' : item.status.toUpperCase()}</span></div><h3>${escapeHtml(item.prompt)}</h3><button data-repeat-mission="${item.id}">Run this mission again ↗</button></div></article>`).join('')
      : `<div class="library-empty"><span>◷</span><h2>${items.length ? 'No missions in this view.' : 'Your mission timeline starts here.'}</h2><p>${items.length ? 'Choose another activity filter.' : 'Every mission you run will be recorded here in this browser.'}</p></div>`;
    $$('[data-repeat-mission]').forEach(button => button.addEventListener('click', () => {
      const item = items.find(entry => String(entry.id) === button.dataset.repeatMission);
      if (item) runMissionPrompt(item.prompt);
    }));
  };
  $$('[data-history-filter]').forEach(button => button.addEventListener('click', () => {
    filter = button.dataset.historyFilter === 'completed' ? 'completed' : button.dataset.historyFilter === 'attention' ? 'attention' : 'all';
    $$('[data-history-filter]').forEach(item => item.classList.toggle('active', item === button));
    render();
  }));
  render();
}

function updateHistory(status) {
  if (!activeHistoryId) return;
  const items = readLocalItems('benet-mission-history', 'mission history');
  const index = items.findIndex(item => item.id === activeHistoryId);
  if (index < 0) return;
  items[index].status = status;
  items[index].updatedAt = Date.now();
  writeLocalItems('benet-mission-history', items, 'mission history');
}

$$('.nav-item').forEach(b => b.addEventListener('click', () => showView(b.dataset.view)));
$$('[data-view-card]').forEach(c => c.addEventListener('click', () => showView(c.dataset.viewCard)));
$$('.card-link').forEach(b => b.addEventListener('click', e => {
  e.stopPropagation();
  showView(b.closest('.cap-card').dataset.viewCard);
}));
$$('.suggestions button').forEach(b => b.addEventListener('click', () => {
  $('#prompt').value = b.dataset.prompt;
  $('#prompt').focus();
}));

$('#attachBtn').addEventListener('click', () => {
  $('#contextNote').textContent = 'Demo context attached · sample workspace';
  toast('Sample context attached to this mission.');
});

function updateMiniBrowser(n) {
  const browser = $('.mini-browser-panel');
  const tabs = $$('.mini-tab');
  tabs.forEach((tab, i) => tab.classList.toggle('active', i === Math.min(n, 3)));
  browser.classList.toggle('running', n < 4);
  browser.classList.toggle('complete', n >= 4);
  if (n === 0) browser.classList.remove('running', 'complete');
}

function completeMissionTrace() {
  clearInterval(timer);
  $$('.step').forEach(step => {
    step.classList.remove('active');
    step.classList.add('done');
    step.querySelector('.step-mark').textContent = '✓';
    step.querySelector('.step-state').textContent = 'DONE';
  });
  $('#progressCount').textContent = '4 / 4';
  $('#progressBar').style.width = '100%';
  updateMiniBrowser(4);
}

function startMission() {
  const prompt = $('#prompt').value.trim();
  if (!prompt) {
    toast('Add a goal first — BENET works best with a clear intent.');
    $('#prompt').focus();
    return;
  }

  activeHistoryId = Date.now();
  const historyItems = readLocalItems('benet-mission-history', 'mission history');
  historyItems.push({
    id: activeHistoryId,
    prompt,
    type: /compare|versus|\bvs\b/i.test(prompt) ? 'COMPARISON' : /register|form|submit|booking/i.test(prompt) ? 'WEB ACTION' : 'RESEARCH',
    status: 'in progress',
    createdAt: activeHistoryId
  });
  writeLocalItems('benet-mission-history', historyItems, 'mission history');

  views.overview.classList.add('hidden');
  views.feature.classList.add('hidden');
  views.agent.classList.remove('hidden');
  $('#pageName').textContent = 'Mission control';
  $('#agentTitle').textContent = 'Your mission is underway.';
  $('#agentSubtitle').textContent = '“' + prompt.slice(0, 105) + (prompt.length > 105 ? '…' : '') + '”';
  $('#resultPanel').classList.add('hidden');

  const steps = [
    ['Understand your question', 'Preparing a keyless web lookup.'],
    ['Check for an instant answer', 'Checking DuckDuckGo answer-box results.'],
    ['Look up a topic summary', 'Using Wikipedia only when no direct answer is available.'],
    ['Present your result', 'Showing linked answers or full-search options.']
  ];
  $('#steps').innerHTML = steps.map((s, i) => `<div class="step" id="step${i}"><span class="step-mark">${i + 1}</span><div><strong>${s[0]}</strong><small>${s[1]}</small></div><span class="step-state">QUEUED</span></div>`).join('');

  let n = 0;
  missionPaused = false;
  pendingMissionPrompt = prompt;
  liveAnswer = '';
  liveSources = [];
  liveError = '';
  liveHasAnswer = false;
  liveIsDemo = false;
  liveAnswerKind = 'Keyless web answer';
  liveAnswerDescription = 'Keyless instant answer and related references.';
  $('#resultPanel .complete').textContent = 'SEARCHING WEB';
  $('#progressCount').textContent = '0 / 4';
  $('#progressBar').style.width = '0%';
  updateMiniBrowser(0);
  clearInterval(timer);
  $('#resultPanel').classList.remove('hidden');

  timer = setInterval(() => {
    if (missionPaused) return;
    if (n > 0) {
      const prev = $('#step' + (n - 1));
      prev.classList.remove('active');
      prev.classList.add('done');
      prev.querySelector('.step-mark').textContent = '✓';
      prev.querySelector('.step-state').textContent = 'DONE';
    }
    if (n < 4) {
      const el = $('#step' + n);
      el.classList.add('active');
      el.querySelector('.step-state').textContent = 'WORKING';
      $('#progressCount').textContent = n + ' / 4';
      $('#progressBar').style.width = (n / 4 * 100) + '%';
      updateMiniBrowser(n);

      if (n === 2 && /register|submission|submit|form|book|booking|web action|conference|hackathon/i.test(prompt)) {
        missionPaused = true;
        $('#approvalFields').textContent = /conference|hackathon|registration|register/i.test(prompt) ? '6' : '4';
        $('#approvalText').textContent = 'BENET filled the prepared details for “' + prompt.slice(0, 70) + '”. Ready to continue?';
        $('#approvalModal').classList.remove('hidden');
      }
      n++;
    } else {
      clearInterval(timer);
      $('#progressCount').textContent = '4 / 4';
      $('#progressBar').style.width = '100%';
      updateMiniBrowser(4);
      $('#resultPanel').classList.remove('hidden');
    }
  }, 1050);
  fetchLiveAnswer(prompt);
}

async function fetchLiveAnswer(prompt) {
  const body = $('.result-body');
  liveAnswer = '';
  liveSources = [];
  liveError = '';
  liveHasAnswer = false;
  liveIsDemo = false;
  liveAnswerKind = 'Keyless web answer';
  liveAnswerDescription = 'Keyless instant answer and related references.';
  $('#resultTitle').textContent = 'Searching the web...';
  body.innerHTML = `<div class="result-summary"><div class="result-symbol">⌕</div><div><h3>Keyless web lookup</h3><p id="resultText">Checking for an instant answer to: ${escapeHtml(prompt)}</p></div></div>`;

  const demoAnswer = getDemoAnswer(prompt);
  if (demoAnswer) {
    liveAnswer = demoAnswer;
    liveHasAnswer = true;
    liveIsDemo = true;
    liveAnswerKind = 'Sample demo answer';
    liveAnswerDescription = 'Illustrative sample output; this is not live web data.';
    updateHistory('completed');
    if (!missionPaused) completeMissionTrace();
    $('#resultPanel .complete').textContent = 'DEMO ANSWER';
    renderMissionOutput(prompt);
    toast('Sample answer ready — this example uses dummy data.');
    return;
  }

  try {
    let data = null;
    let duckDuckGoError = null;
    try {
      data = await requestDuckDuckGoAnswer(prompt);
    } catch (error) {
      duckDuckGoError = error;
    }

    const directAnswer = cleanSearchText(data?.Answer);
    const abstract = cleanSearchText(data?.AbstractText);
    const definition = cleanSearchText(data?.Definition);
    const related = collectRelatedTopics(data?.RelatedTopics);
    const directParts = [directAnswer, abstract, !abstract ? definition : ''].filter(Boolean);

    if (directParts.length) {
      liveHasAnswer = true;
      liveAnswerKind = 'Keyless web answer';
      liveAnswerDescription = 'Instant answer and related references from DuckDuckGo.';
      liveAnswer = directParts.join('\n\n');
      if (related.length) {
        liveAnswer += `\n\nRelated web references:\n${related.slice(0, 3).map(topic => `• ${topic.title}`).join('\n')}`;
      }
      addSearchSource(liveSources, data.AbstractSource || data.Heading, data.AbstractURL);
      addSearchSource(liveSources, data.DefinitionSource || 'Definition', data.DefinitionURL);
      related.forEach(topic => addSearchSource(liveSources, topic.title, topic.url));
    } else {
      let wikipediaResults = [];
      let wikipediaError = null;
      if (!isTimeSensitiveQuestion(prompt)) {
        try {
          wikipediaResults = await requestWikipediaSummaries(prompt);
        } catch (error) {
          wikipediaError = error;
        }
      }

      if (wikipediaResults.length) {
        liveHasAnswer = true;
        liveAnswerKind = 'Wikipedia topic summaries';
        liveAnswerDescription = 'Short Wikipedia excerpts (CC BY-SA); open the linked articles to verify details.';
        liveAnswer = wikipediaResults.map(result => `${result.title}\n${result.extract}`).join('\n\n');
        wikipediaResults.forEach(result => addSearchSource(liveSources, result.title, result.url));
      } else if (related.length) {
        liveHasAnswer = true;
        liveAnswerKind = 'Related web references';
        liveAnswerDescription = 'Related DuckDuckGo references; open a source for more information.';
        liveAnswer = related.slice(0, 3).map(topic => topic.title).join('\n');
        related.forEach(topic => addSearchSource(liveSources, topic.title, topic.url));
      } else if (duckDuckGoError && wikipediaError) {
        liveError = 'Could not load a direct answer. Retry or open full web search.';
      } else {
        liveAnswer = 'No direct answer was found. Use the full web search link below to explore more results.';
        liveAnswerKind = 'No instant answer found';
        liveAnswerDescription = 'Neither instant answers nor topic summaries matched this question.';
      }
    }

    addSearchSource(liveSources, 'Search the web for this question', `https://duckduckgo.com/?q=${encodeURIComponent(prompt)}`);
  } catch (error) {
    liveError = error instanceof Error ? error.message : 'Unable to reach DuckDuckGo for this web lookup.';
    addSearchSource(liveSources, 'Search the web for this question', `https://duckduckgo.com/?q=${encodeURIComponent(prompt)}`);
  }

  updateHistory(liveError || !liveHasAnswer ? 'attention' : 'completed');
  if (!missionPaused && !liveError) completeMissionTrace();
  $('#resultPanel .complete').textContent = liveError ? 'LOOKUP FAILED' : liveHasAnswer ? 'ANSWER READY' : 'MORE RESULTS';
  renderMissionOutput(prompt);
  if (liveError) {
    toast('Web lookup unavailable. See the mission result for details.');
  } else if (!liveHasAnswer) {
    toast('No instant answer found. Open the full web search link in the result.');
  } else {
    toast('Web answer ready — review the linked sources.');
  }
}

function renderMissionOutput(prompt) {
  const body = $('.result-body');
  $('#resultTitle').textContent = makeTitle(prompt);
  if (liveError) {
    $('#resultText').textContent = 'The live answer request did not complete.';
    body.innerHTML = `
      <div class="result-summary"><div class="result-symbol">!</div><div><h3>Live web answer unavailable</h3><p>${escapeHtml(liveError)}</p></div></div>
      <div class="answer-sources" id="answerSources"></div>
      <button class="run-btn" id="retryAnswer" style="margin-top:12px">Try again ↻</button>
      <button class="modify-btn" id="newMission" style="margin:12px 0 0 8px">New question</button>`;
    const searchLink = document.createElement('a');
    searchLink.href = `https://duckduckgo.com/?q=${encodeURIComponent(prompt)}`;
    searchLink.target = '_blank';
    searchLink.rel = 'noopener noreferrer';
    searchLink.textContent = 'Open full web search';
    $('#answerSources').appendChild(searchLink);
    $('#retryAnswer').addEventListener('click', () => fetchLiveAnswer(prompt));
    $('#newMission').addEventListener('click', resetMission);
  } else if (liveAnswer) {
    $('#resultText').textContent = liveAnswerDescription;
    body.innerHTML = `
      <div class="result-summary"><div class="result-symbol">${liveIsDemo ? '◌' : '⌕'}</div><div><h3>${liveAnswerKind}</h3><p>${escapeHtml(liveAnswer)}</p></div></div>
      <div class="answer-sources" id="answerSources"></div>
      <button class="modify-btn" id="saveDiscovery" style="margin-top:12px">Save to discoveries ▤</button>
      <button class="run-btn" id="newMission" style="margin-top:12px">Start another mission ↗</button>`;
    const sourceList = $('#answerSources');
    liveSources.forEach(source => {
      try {
        const url = new URL(source.url);
        if (!['http:', 'https:'].includes(url.protocol)) return;
        const link = document.createElement('a');
        link.href = url.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = source.title || url.hostname;
        sourceList.appendChild(link);
      } catch {
        return;
      }
    });
    if (liveIsDemo) sourceList.innerHTML = '<small>DEMO ANSWER · NO LIVE SOURCES</small>';
    else if (liveSources.length) sourceList.insertAdjacentHTML('afterbegin', '<small>WEB SOURCES &amp; SEARCH</small>');
    $('#saveDiscovery').addEventListener('click', () => {
      const items = readLocalItems('benet-saved-discoveries', 'saved discoveries');
      items.unshift({
        id: Date.now(),
        prompt,
        answer: liveAnswer,
        sources: liveSources,
        type: /compare|versus|\bvs\b/i.test(prompt) ? 'compare' : 'research',
        savedAt: new Date().toISOString()
      });
      if (writeLocalItems('benet-saved-discoveries', items, 'discovery')) {
        toast('Saved to your discoveries.');
        showView('saved');
      }
    });
    $('#newMission').addEventListener('click', resetMission);
  } else if (/compare|headphone|laptop|phone|product/i.test(prompt)) {
    $('#resultText').textContent = 'Three strong options, ranked around the priorities in your mission.';
    body.innerHTML = `
      <div class="compare-output">
        <div class="sort-toggle"><button class="active" data-sort="performance">Sort: Performance</button><button data-sort="price">Sort: Price</button></div>
        <div class="comparison-table" id="comparisonTable">
          <div><strong>Model</strong></div><div class="top-pick"><strong>Sony WH-1000XM5</strong><span class="benet-pick">BENET TOP PICK</span></div><div><strong>Bose QC Ultra</strong></div><div><strong>Sennheiser Accentum</strong></div>
          <div>Price</div><div data-price="14900" data-performance="94">₹14,900</div><div data-price="12999" data-performance="91">₹12,999</div><div data-price="13990" data-performance="89">₹13,990</div>
          <div>Noise cancellation</div><div>Excellent</div><div>Excellent</div><div>Very good</div>
          <div>Battery</div><div>30 hours</div><div>24 hours</div><div>50 hours</div>
        </div>
      </div>`;
    bindComparisonSort();
  } else if (/opportunit|internship|intern|find/i.test(prompt)) {
    $('#resultText').textContent = 'A shortlist of relevant opportunities with deadlines and preparation steps.';
    body.innerHTML = `
      <div class="opportunity-grid">
        <article class="opportunity-card"><span class="match-ring">96%</span><small>DEADLINE · 8 DAYS</small><h4>Google Summer of AI</h4><p>AI/ML · Remote · Student track</p><button data-opportunity="Google Summer of AI">Preview Auto-Fill</button></article>
        <article class="opportunity-card"><span class="match-ring">91%</span><small>DEADLINE · 12 DAYS</small><h4>Microsoft Engineering Internship</h4><p>Engineering · Hybrid · 2026</p><button data-opportunity="Microsoft Engineering Internship">Preview Auto-Fill</button></article>
        <article class="opportunity-card"><span class="match-ring">88%</span><small>DEADLINE · 18 DAYS</small><h4>OpenAI Fellows Prototype</h4><p>Research · Global · Portfolio-based</p><button data-opportunity="OpenAI Fellows Prototype">Preview Auto-Fill</button></article>
      </div>`;
    $$('[data-opportunity]').forEach(btn => btn.addEventListener('click', () => openAutofill(btn.dataset.opportunity)));
  } else if (/trip|travel|plan|goa/i.test(prompt)) {
    $('#resultText').textContent = 'A compact three-day Goan itinerary with realistic daily estimates.';
    body.innerHTML = `
      <div class="trip-board">
        <article class="trip-day"><small>DAY 01 · ARRIVE</small><h4>North Goa</h4><ul><li>Calangute beach</li><li>Café hopping</li><li>Sunset at Chapora</li></ul><div class="trip-cost">Est. ₹3,800 / person</div></article>
        <article class="trip-day"><small>DAY 02 · EXPLORE</small><h4>Old Goa</h4><ul><li>Basilica of Bom Jesus</li><li>Fontainhas walk</li><li>Mandovi river cruise</li></ul><div class="trip-cost">Est. ₹4,200 / person</div></article>
        <article class="trip-day"><small>DAY 03 · WIND DOWN</small><h4>South Goa</h4><ul><li>Palolem beach</li><li>Local seafood lunch</li><li>Evening departure</li></ul><div class="trip-cost">Est. ₹3,500 / person</div></article>
      </div><div class="metric" style="margin-top:12px"><strong>₹11.5k</strong><span>Estimated 3-day total, excluding travel</span></div>`;
  } else {
    body.innerHTML = `<div class="result-summary"><div class="result-symbol">✳</div><div><h3>A clearer path forward.</h3><p>BENET organised the request into a useful starting point.</p></div></div><div class="result-columns"><div><small>WHAT YOU GET</small><ul><li>Key findings grouped by relevance</li><li>Source-aware notes and next steps</li><li>A concise recommendation</li></ul></div><div><small>WHAT HAPPENS NEXT</small><ul><li>Review the prepared output</li><li>Adjust anything that needs your input</li><li>Approve external actions yourself</li></ul></div></div><button class="run-btn" id="newMission">Start another mission ↗</button>`;
    $('#newMission').addEventListener('click', resetMission);
  }

  if (!body.querySelector('#newMission') && !$('.result-body .run-btn')) body.insertAdjacentHTML('beforeend', '<button class="run-btn" id="newMission" style="margin-top:12px">Start another mission ↗</button>');
  const newMission = $('#newMission');
  if (newMission) newMission.addEventListener('click', resetMission);
}

function makeTitle(p) {
  if (/compare|best|under|laptop|phone|headphone/i.test(p)) return 'A decision-ready comparison.';
  if (/trip|travel|plan|goa/i.test(p)) return 'A 3-day plan you can use.';
  if (/intern|research|find|opportunit/i.test(p)) return 'A focused opportunity shortlist.';
  return 'A clearer path forward.';
}

function bindComparisonSort() {
  $$('.sort-toggle button').forEach(btn => btn.addEventListener('click', () => {
    $$('.sort-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const table = $('#comparisonTable');
    const priceRow = table.children[5];
    toast(btn.dataset.sort === 'price' ? 'Sorted by lowest price' : 'Sorted by BENET performance score');
  }));
}

function openAutofill(name) {
  $('#autofillFields').innerHTML = `<div><span>Full name</span><strong>Guest Workspace</strong></div><div><span>University</span><strong>Student Engineering</strong></div><div><span>Target role</span><strong>AI/ML Intern</strong></div><div><span>Opportunity</span><strong>${name}</strong></div>`;
  $('#autofillModal').classList.remove('hidden');
}

function resetMission() {
  showView('overview');
  $('#prompt').value = '';
  $('#prompt').focus();
}

$('#runAgent').addEventListener('click', startMission);
$('#newMission').addEventListener('click', resetMission);
$('#learnMore').addEventListener('click', () => toast('BENET is an intent-first web agent concept.'));
$('.help-btn').addEventListener('click', () => toast('Demo mode: use the mission box to explore BENET.'));

$('#approveAction').addEventListener('click', () => {
  missionPaused = false;
  $('#approvalModal').classList.add('hidden');
  toast('Approved — BENET can continue.');
});
$('#modifyAction').addEventListener('click', () => {
  missionPaused = false;
  clearInterval(timer);
  $('#approvalModal').classList.add('hidden');
  showView('overview');
  $('#prompt').focus();
  toast('Modify the mission, then run it again.');
});
$('#closeAutofill').addEventListener('click', () => $('#autofillModal').classList.add('hidden'));

const paletteCommands = [
  { icon: '⌕', title: 'Research agent', subtitle: 'Open deep research workspace', key: 'research', view: 'research' },
  { icon: '⇄', title: 'Compare products', subtitle: 'Run a headphone comparison demo', key: 'compare', prompt: 'Compare the top 5 noise-cancelling headphones under ₹15,000.' },
  { icon: '↗', title: 'Find opportunities', subtitle: 'Run an internship shortlist demo', key: 'opportunity', prompt: 'Research the best AI/ML internships for engineering students.' },
  { icon: '◷', title: 'Plan a trip', subtitle: 'Create a 3-day Goa itinerary', key: 'trip', prompt: 'Plan a 3-day budget trip to Goa with beaches, transport and stays.' },
  { icon: '▤', title: 'Saved discoveries', subtitle: 'Open saved workspace', key: 'saved', view: 'saved' }
];

function openPalette() {
  $('#paletteModal').classList.remove('hidden');
  $('#paletteInput').value = '';
  renderPalette();
  setTimeout(() => $('#paletteInput').focus(), 20);
}
function closePalette() { $('#paletteModal').classList.add('hidden'); }
function renderPalette(query = '') {
  const items = paletteCommands.filter(c => (c.title + ' ' + c.subtitle).toLowerCase().includes(query.toLowerCase()));
  $('#paletteResults').innerHTML = items.map((c, i) => `<button class="palette-option${i === 0 ? ' selected' : ''}" data-key="${c.key}"><span>${c.icon}</span><div><strong>${c.title}</strong><small>${c.subtitle}</small></div><b>OPEN</b></button>`).join('');
  $$('.palette-option').forEach(btn => btn.addEventListener('click', () => {
    const item = paletteCommands.find(c => c.key === btn.dataset.key);
    closePalette();
    if (item.view) showView(item.view);
    if (item.prompt) { showView('overview'); $('#prompt').value = item.prompt; startMission(); }
  }));
}
$('#paletteTrigger').addEventListener('click', openPalette);
$('#paletteInput').addEventListener('input', e => renderPalette(e.target.value));

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (SpeechRecognition) {
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.onstart = () => { $('#micBtn').classList.add('listening'); toast('Listening… speak your mission'); };
  recognition.onresult = e => {
    let transcript = '';
    for (let i = e.resultIndex; i < e.results.length; i++) transcript += e.results[i][0].transcript;
    $('#prompt').value = transcript.trim();
  };
  recognition.onend = () => {
    $('#micBtn').classList.remove('listening');
    if ($('#prompt').value.trim()) {
      toast('Voice captured — starting BENET');
      setTimeout(startMission, 350);
    }
  };
  recognition.onerror = () => toast('Voice recognition was unavailable. Try typing your mission.');
  $('#micBtn').addEventListener('click', () => recognition.start());
} else {
  $('#micBtn').addEventListener('click', () => toast('Voice recognition is not supported in this browser.'));
}

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
  }
  if (e.key === 'Escape') {
    closePalette();
    $('#approvalModal').classList.add('hidden');
    $('#autofillModal').classList.add('hidden');
  }
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startMission();
});
