(() => {
  'use strict';
  const ICONS = {{icons_json}};
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const root = document.documentElement;
  const body = document.body;
  const reduceMotion = window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const icon = name => ICONS[name] || '';

  /* ------------------------------------------------------------------ Theme */
  const THEME_KEY = 'deco-blocks-docs-theme';
  const mqDark = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  // The header toggle, plus the one in the mobile drawer (the landing moves it there below 900px).
  const themeBtns = $$('[data-theme-toggle]');
  const effectiveTheme = () => {
    const t = root.dataset.theme;
    if (t === 'dark' || t === 'light') return t;
    return mqDark && mqDark.matches ? 'dark' : 'light';
  };
  function syncThemeButton() {
    const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    themeBtns.forEach(btn => {
      btn.setAttribute('aria-label', 'Switch to ' + next + ' mode');
      btn.title = 'Switch to ' + next + ' mode';
      const label = $('.theme-label', btn);
      if (label) label.textContent = next === 'dark' ? 'Dark mode' : 'Light mode';
    });
  }
  function setTheme(theme) {
    root.dataset.theme = theme;
    try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
    syncThemeButton();
  }
  themeBtns.forEach(btn => btn.addEventListener('click', () => setTheme(effectiveTheme() === 'dark' ? 'light' : 'dark')));
  if (mqDark && mqDark.addEventListener) mqDark.addEventListener('change', syncThemeButton);
  syncThemeButton();

  /* -------------------------------------------------------------- Structure */
  const pages = $$('main .page');
  const sections = $$('main .page > section');
  const pageOf = new Map();
  pages.forEach(page => $$(':scope > section', page).forEach(section => pageOf.set(section.id, page.dataset.page)));
  const groupsByPage = {
    home: [],
    docs: [["Getting started", ["architecture", "quickstart"]], ["Core concepts", ["model", "content", "schema", "preview"]], ["Advanced", ["manifest", "variants"]], ["Websites", ["content-types", "rendering", "routing"]], ["Reference", ["standalone"]], ["Framework guides", ["nextjs", "tanstack-data", "tanstack-rsc"]], ["Production", ["releases", "operations", "adoption", "troubleshooting"]]],
    internals: [["Under the hood", ["internals", "walkthrough", "loader-internals", "router-internals", "studio", "decisions"]]],
    roadmap: [["Overview", ["roadmap"]], ["Release blockers", ["roadmap-blockers"]], ["Studio support", ["roadmap-studio-new", "roadmap-studio-legacy"]], ["Work items", ["roadmap-api", "roadmap-cli", "roadmap-platform", "roadmap-docs"]], ["Site migrations", ["roadmap-storefront", "roadmap-blog", "roadmap-faststore"]], ["Feature readiness", ["roadmap-features"]]],
  };
  const pageLabels = { home: 'Home', docs: 'Docs', internals: 'Under the hood', roadmap: 'Roadmap' };
  const pageHeadings = { docs: 'Deco Blocks documentation', internals: 'Deco Blocks: under the hood', roadmap: 'Deco Blocks: next-major roadmap' };
  const groupIcons = { 'Getting started': 'play', 'Core concepts': 'box', 'Advanced': 'sliders', 'Websites': 'globe', 'Reference': 'book', 'Framework guides': 'layers', 'Production': 'server', 'Under the hood': 'cpu', 'Overview': 'eye', 'Release blockers': 'zap', 'Studio support': 'pencil', 'Work items': 'git-branch', 'Site migrations': 'globe', 'Feature readiness': 'list' };
  const pageEntry = { home: 'home', docs: 'architecture', internals: 'internals', roadmap: 'roadmap' };
  const groupOf = new Map();
  const reading = [];
  // One reading order across the doc pages: the pager runs Docs → Under the hood → Roadmap.
  ['docs', 'internals', 'roadmap'].forEach(page => groupsByPage[page].forEach(([group, ids]) => ids.forEach(id => { groupOf.set(id, group); reading.push(id); })));
  const byId = id => document.getElementById(id);
  const navLabel = section => section.dataset.nav || ($('h2', section) && $('h2', section).textContent.trim()) || 'Overview';
  // A section alone in a sidebar group of the same name (the Roadmap's "Overview") goes by its
  // heading in search results and the pager, where "Overview" alone would say little.
  const soleInGroup = section => groupOf.get(section.id) === navLabel(section);
  const cardTitle = section => (soleInGroup(section) && section.dataset.title) || navLabel(section);

  /* ------------------------------------------------ Heading ids and anchors */
  const slugify = text => text.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section';
  // A section's title heading: the landing's h1, otherwise the article's h2.
  const titleHeading = section => $('h1', section) || $('h2', section);
  // The permalink sits inside its heading; the heading keeps its own text as its name, so a
  // screen reader's heading list says "API reference", not "API reference Link to API reference".
  const addAnchor = (heading, href, text) => {
    heading.setAttribute('aria-label', text);
    const a = document.createElement('a');
    a.className = 'heading-anchor'; a.href = href; a.innerHTML = icon('link');
    a.setAttribute('aria-label', 'Link to ' + text);
    heading.append(a);
  };
  sections.forEach(section => {
    const h2 = titleHeading(section);
    if (h2) { section.dataset.title = h2.textContent.trim().replace(/\s+/g, ' '); h2.tabIndex = -1; }
    if (section.id === 'home') return;
    if (h2) addAnchor(h2, '#' + section.id, section.dataset.title);
    $$('h3', section).forEach(h3 => {
      const text = h3.textContent.trim();
      if (!h3.id) {
        const base = section.id + '--' + slugify(text);
        let id = base, n = 2;
        while (byId(id)) id = base + '-' + n++;
        h3.id = id;
      }
      h3.dataset.title = text;
      addAnchor(h3, '#' + h3.id, text);
    });
  });

  /* ------------------------------------------------------------------ Toast */
  const live = $('#live');
  function announce(message) {
    // Cleared first and set a beat later, so a repeat of the same message is still read out.
    live.textContent = '';
    clearTimeout(announce.timer); announce.timer = setTimeout(() => { live.textContent = message; }, 60);
  }
  function toast(message) {
    const el = $('#toast');
    el.textContent = message; el.hidden = false;
    announce(message);
    clearTimeout(toast.timer); toast.timer = setTimeout(() => { el.hidden = true; }, 2200);
  }
  async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (e) {
      const field = document.createElement('textarea');
      field.value = text; field.setAttribute('readonly', ''); field.style.position = 'fixed'; field.style.opacity = '0';
      document.body.append(field); field.select();
      let ok = false; try { ok = document.execCommand('copy'); } catch (err) {}
      field.remove(); return ok;
    }
  }

  /* ------------------------------------------------------------ Code blocks */
  const languageLabels = { typescript: 'TypeScript', tsx: 'TSX', json: 'JSON', jsonc: 'JSON', bash: 'Shell', text: 'Text' };
  const extensionLanguages = { ts: 'typescript', mts: 'typescript', tsx: 'tsx', jsx: 'tsx', js: 'typescript', json: 'json', jsonc: 'jsonc', sh: 'bash' };
  // JSX in a TypeScript block: a closing tag, a self-closing capitalized tag, or a fragment.
  const looksLikeJsx = text => /<\/[A-Za-z][\w.]*>|<[A-Z][\w.]*(\s[^<>]*)?\/>|<>|<\/>/.test(text);
  function fileNameFor(pre) {
    const caption = pre && pre.closest('figure.code-example') && pre.closest('figure.code-example').querySelector('figcaption');
    return caption ? caption.textContent.trim() : '';
  }
  function highlightCode(code, language) {
    const pre = code.closest('pre');
    const fileName = fileNameFor(pre);
    const extension = (fileName.match(/\.(\w+)(?:\s|$|\))/) || [])[1];
    language = language || extensionLanguages[extension] || (code.className.match(/language-([\w-]+)/) || [])[1] || 'typescript';
    if (language === 'typescript' && looksLikeJsx(code.textContent)) language = 'tsx';
    code.className = 'language-' + language;
    if (pre) {
      pre.dataset.lang = languageLabels[language] || language;
      pre.dataset.label = fileName || pre.dataset.lang;
      pre.classList.toggle('has-file', Boolean(fileName));
      if (fileName) pre.setAttribute('aria-label', fileName);
    }
    if (window.Prism && Prism.languages[language]) Prism.highlightElement(code);
  }
  $$('pre > code').forEach(code => { if (!code.closest('.jp, .ci-visual')) highlightCode(code); });
  const langIcon = label => label === 'Shell' ? icon('terminal') : icon('code');

  function makeCopyButton(getText, withLabel) {
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'copy-button' + (withLabel ? ' has-label' : '');
    btn.setAttribute('aria-label', 'Copy code example');
    btn.innerHTML = icon('copy') + icon('check') + (withLabel ? '<span class="copy-label">Copy</span>' : '');
    const label = btn.querySelector('.copy-label');
    btn.addEventListener('click', async () => {
      const ok = await copyText(getText());
      if (!ok) { toast('Select the code to copy it.'); return; }
      btn.classList.add('copied'); btn.setAttribute('aria-label', 'Copied'); announce('Copied to clipboard');
      if (label) label.textContent = 'Copied';
      setTimeout(() => { btn.classList.remove('copied'); btn.setAttribute('aria-label', 'Copy code example'); if (label) label.textContent = 'Copy'; }, 1800);
    });
    return btn;
  }
  const langBadge = label => { const lang = document.createElement('span'); lang.className = 'code-lang'; lang.textContent = label; lang.setAttribute('aria-hidden', 'true'); return lang; };
  // "cms.ts" is a path; "A plain request handler" describes the block; "blocks.tsx
  // (Next.js)" and ".deco/schema.json, abridged" are a path with a note.
  const PATH = /^([^\s,]*\/[^\s,]*|[^\s,]+\.[a-z]\w*)(?=$|[\s,])/i;
  $$('pre').forEach(pre => {
    if (pre.closest('.explorer, .jp, .ci-visual, .sw')) return;
    const code = $('code', pre);
    const text = () => (code ? code.textContent : pre.textContent);
    const file = fileNameFor(pre);
    const raw = text().replace(/\s+$/, '');
    const isBash = /language-bash/.test(code ? code.className : '');
    const panel = document.createElement('div');
    panel.className = 'code-panel' + (raw.includes('\u2502') ? ' is-diagram' : '');
    pre.before(panel);
    let label = pre.dataset.lang || 'Code';
    if (!file && isBash && /^https?:\/\//.test(raw)) label = 'URL';
    if (!pre.hasAttribute('aria-label')) pre.setAttribute('aria-label', label === 'URL' ? 'URL' : label + ' code');
    if (!file && !raw.includes('\n') && isBash && /^(npm|npx|pnpm|yarn|bun)\b/.test(raw)) {
      // A one-line shell command: a compact prompt row with its language badge and copy button.
      panel.classList.add('is-oneline', 'is-cmd');
      panel.append(pre, langBadge(label), makeCopyButton(text, false));
      return;
    }
    const path = file && file.match(PATH);
    const kind = !file ? 'is-lang' : path ? '' : 'is-desc';
    const head = document.createElement('div');
    head.className = 'code-head' + (kind ? ' ' + kind : '');
    head.innerHTML = kind ? langIcon(label) : icon('file');
    const name = document.createElement('span'); name.className = 'code-file'; name.setAttribute('aria-hidden', 'true');
    if (path && path[0].length < file.length) {
      const note = document.createElement('span'); note.className = 'cf-note'; note.textContent = file.slice(path[0].length);
      name.append(path[0], note);
    } else name.textContent = file || label;
    head.append(name);
    if (file) head.append(langBadge(label));
    head.append(makeCopyButton(text, true));
    panel.append(head, pre);
  });

  /* Scroll hints and focus for code that doesn't fit its panel. A block that scrolls is a tab
     stop (a named region, so arrow keys can scroll it); one that fits is not. The fade marks the
     edge it continues past, and goes once that edge is reached. */
  function fadeCode(pre) {
    const x = pre.scrollLeft, maxX = pre.scrollWidth - pre.clientWidth, maxY = pre.scrollHeight - pre.clientHeight;
    pre.classList.toggle('fade-l', x > 1);
    pre.classList.toggle('fade-r', maxX > 1 && x < maxX - 1);
    pre.classList.toggle('fade-b', maxY > 1 && pre.scrollTop < maxY - 1);
  }
  function fitCode(scope) {
    $$('.code-panel > pre', scope).forEach(pre => {
      if (!pre.offsetParent) return;
      const scrolls = pre.scrollWidth > pre.clientWidth + 1 || pre.scrollHeight > pre.clientHeight + 1;
      if (scrolls) { pre.tabIndex = 0; pre.setAttribute('role', 'region'); }
      else { pre.removeAttribute('tabindex'); pre.removeAttribute('role'); }
      fadeCode(pre);
    });
  }
  $$('.code-panel > pre').forEach(pre => pre.addEventListener('scroll', () => {
    if (pre.fadeTick) return;
    pre.fadeTick = requestAnimationFrame(() => { pre.fadeTick = 0; fadeCode(pre); });
  }, { passive: true }));

  // Short inline code ("product-card") stays on one line; long tokens may still wrap anywhere.
  $$('.doc-section :not(pre) > code').forEach(c => { if (c.textContent.trim().length <= 24) c.classList.add('is-short'); });
  $$('main table').forEach(table => {
    if (!table.parentElement.classList.contains('table-wrap')) {
      const wrap = document.createElement('div'); wrap.className = 'table-wrap';
      table.before(wrap); wrap.append(table);
    }
    // Multi-word code (signatures like `remoteLoader(content, { token })`) may wrap at its
    // spaces on phones; single identifiers such as "not-found" stay on one line.
    $$('td code, th code', table).forEach(c => { if (/\s/.test(c.textContent.trim())) c.classList.add('can-wrap'); });
  });

  /* ------------------------------------------------------------ Sidebar toc */
  const toc = $('#toc');
  const navLinks = new Map();
  let tocPage = null;
  function buildToc(page) {
    const source = page === 'home' ? 'docs' : page;
    if (tocPage === source) return;
    tocPage = source;
    toc.replaceChildren(); navLinks.clear();
    groupsByPage[source].forEach(([title, ids], gi) => {
      const group = document.createElement('div'); group.className = 'nav-group';
      const label = document.createElement('p'); label.className = 'nav-label';
      label.id = 'nav-group-' + source + '-' + gi;
      label.innerHTML = icon(groupIcons[title] || 'book'); label.append(title);
      const list = document.createElement('ul'); list.className = 'nav-list';
      list.setAttribute('aria-labelledby', label.id);
      ids.forEach(id => {
        const section = byId(id); if (!section) return;
        const li = document.createElement('li');
        const a = document.createElement('a'); a.href = '#' + id; a.textContent = navLabel(section);
        li.append(a); list.append(li); navLinks.set(id, a);
      });
      group.append(label, list); toc.append(group);
    });
  }
  function fadeToc() {
    const max = toc.scrollHeight - toc.clientHeight;
    toc.classList.toggle('more-above', toc.scrollTop > 1);
    toc.classList.toggle('more-below', max > 1 && toc.scrollTop < max - 1);
  }
  toc.addEventListener('scroll', fadeToc, { passive: true });

  /* ----------------------------------------------------------- Article chrome */
  const crumb = $('#breadcrumb');
  function buildBreadcrumb(section) {
    const page = pageOf.get(section.id);
    crumb.replaceChildren();
    const add = (text, href) => {
      const li = document.createElement('li');
      if (href) { const a = document.createElement('a'); a.href = href; a.textContent = text; li.append(a); }
      else { const span = document.createElement('span'); span.textContent = text; li.append(span); }
      crumb.append(li); return li;
    };
    add(pageLabels[page], '#' + pageEntry[page]);
    const group = groupOf.get(section.id);
    if (group && group !== pageLabels[page] && group !== navLabel(section)) add(group);
    const last = add(navLabel(section));
    last.firstChild.setAttribute('aria-current', 'page');
  }
  const pager = $('#pager');
  function pagerCard(id, dir) {
    const section = byId(id);
    const a = document.createElement('a');
    a.href = '#' + id; a.className = dir === 'prev' ? 'pg-prev' : 'pg-next';
    const d = document.createElement('span'); d.className = 'pg-dir';
    d.innerHTML = dir === 'prev' ? icon('arrow-left') + '<span>Previous</span>' : '<span>Next</span>' + icon('arrow-right');
    const t = document.createElement('span'); t.className = 'pg-title'; t.textContent = cardTitle(section);
    const s = document.createElement('span'); s.className = 'pg-sub';
    const page = pageOf.get(id);
    const group = groupOf.get(id);
    s.textContent = group && group !== pageLabels[page] && group !== navLabel(section) ? pageLabels[page] + ' › ' + group : pageLabels[page];
    a.append(d, t, s);
    return a;
  }
  function buildPager(section) {
    pager.replaceChildren();
    const i = reading.indexOf(section.id);
    if (i < 0) return;
    if (i > 0) pager.append(pagerCard(reading[i - 1], 'prev'));
    if (i < reading.length - 1) pager.append(pagerCard(reading[i + 1], 'next'));
  }

  /* -------------------------------------------------- Right rail + scroll-spy */
  const railList = $('#rail-list');
  const indicator = $('#rail-indicator');
  const inlineList = $('#toc-inline-list');
  const tocInline = $('#toc-inline');
  let spy = [];
  function railLabel(el) {
    const clone = el.cloneNode(true);
    $$('.heading-anchor', clone).forEach(n => n.remove());
    return clone.innerHTML.trim();
  }
  const railNav = $('#rail-nav');
  inlineList.addEventListener('click', event => { if (event.target.closest('a')) tocInline.open = false; });
  function placeInlineToc(section) {
    // Below 1200px the page outline sits under the title and lede, not above them.
    const h2 = $('h2', section);
    let anchor = h2;
    if (h2 && h2.nextElementSibling && h2.nextElementSibling.tagName === 'P') anchor = h2.nextElementSibling;
    if (anchor) anchor.after(tocInline); else section.prepend(tocInline);
  }
  function buildRail(section) {
    railList.replaceChildren(); inlineList.replaceChildren();
    spy = [];
    const items = [{ id: section.id, el: section, html: 'Overview', top: true }]
      .concat($$('h3', section).filter(h3 => !h3.hidden).map(h3 => ({ id: h3.id, el: h3, html: railLabel(h3) })));
    railNav.hidden = items.length < 2;
    placeInlineToc(section);
    items.forEach(item => {
      const li = document.createElement('li');
      const a = document.createElement('a'); a.href = '#' + item.id; a.innerHTML = item.html;
      li.append(a); railList.append(li);
      const li2 = document.createElement('li'); if (item.top) li2.className = 'is-top';
      const a2 = document.createElement('a'); a2.href = '#' + item.id; a2.innerHTML = item.html;
      li2.append(a2); inlineList.append(li2);
      spy.push({ el: item.el, link: a });
    });
    tocInline.open = false;
    tocInline.hidden = items.length < 2;
  }
  let lastActive = null;
  document.addEventListener('roadmap:filter', () => {
    if (activeSection && activeSection.id === 'roadmap-features') { buildRail(activeSection); lastActive = null; updateSpy(); }
  });
  function updateSpy() {
    if (!spy.length || body.dataset.layout !== 'docs') return;
    const line = $('#site-header').offsetHeight + 40;
    let current = spy[0];
    for (let i = 1; i < spy.length; i++) if (spy[i].el.getBoundingClientRect().top <= line) current = spy[i];
    const doc = document.documentElement;
    if (scrollY > 0 && doc.scrollHeight > innerHeight + 8 && innerHeight + scrollY >= doc.scrollHeight - 2) {
      // At the very bottom the last headings can't reach the line; pick the last one that is on screen.
      for (let i = spy.length - 1; i > 0; i--) { if (spy[i].el.getBoundingClientRect().top < innerHeight) { current = spy[i]; break; } }
    }
    if (current !== lastActive) {
      spy.forEach(s => { s.link.classList.toggle('active', s === current); if (s === current) s.link.setAttribute('aria-current', 'location'); else s.link.removeAttribute('aria-current'); });
      lastActive = current;
      // A long outline scrolls inside the rail; keep the current entry in view, clear of the edges.
      if (railNav.scrollHeight > railNav.clientHeight + 1) {
        const box = railNav.getBoundingClientRect(), r = current.link.getBoundingClientRect();
        if (r.top < box.top + 40 || r.bottom > box.bottom - 24) railNav.scrollTop += r.top - box.top - box.height / 3;
      }
    }
    const a = current.link;
    if (a.offsetParent) {
      indicator.style.transform = 'translateY(' + a.offsetTop + 'px)';
      indicator.style.height = a.offsetHeight + 'px';
      indicator.classList.add('on');
    }
  }

  /* ----------------------------------------------------------------- Header */
  const header = $('#site-header');
  function updateHeader() {
    // On the landing the header keeps its on-band look everywhere: over the hero it is
    // transparent, and once scrolled it becomes the site's dark floating pill.
    const on = body.dataset.layout === 'landing';
    header.classList.toggle('on-band', Boolean(on));
    header.classList.toggle('is-scrolled', window.scrollY > 4);
  }

  /* ------------------------------------------------ Entrance on scroll-in */
  // The site's deco-reveal: fade up once when a block first enters the viewport.
  let pendingReveals = $$('.reveal');
  const revealAll = () => { pendingReveals.forEach(el => el.classList.add('in')); pendingReveals = []; };
  // Fallback beside the observer: anything already scrolled into (or past) view is shown.
  function checkReveals() {
    if (!pendingReveals.length || body.dataset.layout !== 'landing') return;
    const limit = innerHeight * 0.95;
    pendingReveals = pendingReveals.filter(el => {
      const r = el.getBoundingClientRect();
      if (r.width && r.top < limit) { el.classList.add('in'); return false; }
      return true;
    });
  }
  if (reduceMotion || !('IntersectionObserver' in window)) revealAll();
  else {
    const io = new IntersectionObserver(entries => entries.forEach(entry => {
      if (entry.isIntersecting) { entry.target.classList.add('in'); io.unobserve(entry.target); pendingReveals = pendingReveals.filter(el => el !== entry.target); }
    }), { rootMargin: '0px 0px -6% 0px', threshold: 0.05 });
    pendingReveals.forEach(el => io.observe(el));
    window.addEventListener('beforeprint', revealAll);
  }

  /* ---------------------------------------------------------------- Routing */
  let activePage = null;
  let activeSection = null;
  function setTabs(page) {
    $$('.tabs a, .drawer-tabs a').forEach(a => {
      if (a.dataset.tab === page) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
  }
  function showSection(section) {
    const page = pageOf.get(section.id);
    if (page !== activePage) {
      activePage = page;
      pages.forEach(p => p.classList.toggle('active', p.dataset.page === page));
      body.dataset.layout = page === 'home' ? 'landing' : 'docs';
      body.dataset.page = page;
      setTabs(page);
      buildToc(page);
      const ph = $('#page-heading'); if (ph) ph.textContent = pageHeadings[page] || pageHeadings.docs;
    }
    if (section !== activeSection) {
      activeSection = section;
      sections.forEach(s => s.classList.toggle('is-current', s === section));
      navLinks.forEach((a, id) => { const on = id === section.id; a.classList.toggle('active', on); if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); });
      lastActive = null;
      if (page !== 'home') { buildBreadcrumb(section); buildPager(section); buildRail(section); fitCode(section); }
      document.title = page === 'home' ? 'Deco Blocks — The AI-native headless CMS' : (navLabel(section) === 'Overview' ? pageLabels[page] : navLabel(section)) + ' — Deco Blocks';
      const active = navLinks.get(section.id);
      if (active && active.scrollIntoView) {
        // Keep the current link clear of the edge fades (28px top, 48px bottom), not just inside the box.
        const box = toc.getBoundingClientRect(), r = active.getBoundingClientRect();
        if ((r.top < box.top + 28 && toc.scrollTop > 0) || r.bottom > box.bottom - 48) toc.scrollTop += r.top - box.top - box.height / 3;
      }
      fadeToc();
    }
  }
  // A deep link into a collapsed <details> opens it first, so the target can be scrolled to.
  // (The Roadmap's feature list clears its own status/site filter, before this runs.)
  function revealTarget(target, section) {
    for (let d = target.closest('details'); d && section.contains(d); d = d.parentElement.closest('details')) d.open = true;
  }
  function currentId() {
    const raw = location.hash.slice(1);
    try { return decodeURIComponent(raw); } catch (e) { return raw; }
  }
  function route(fromUser) {
    const id = currentId() || 'home';
    let target = byId(id);
    let section = target && target.closest('main .page > section');
    if (!section) {
      const entry = pageEntry[id];
      section = byId(entry || 'home');
      target = section;
    }
    const switching = section !== activeSection;
    showSection(section);
    closeMenu(false);
    if (target && target !== section) revealTarget(target, section);
    if (!target || target === section) {
      window.scrollTo(0, 0);
      if (fromUser && switching) { const h = titleHeading(section); if (h) h.focus({ preventScroll: true }); }
    } else {
      target.scrollIntoView({ block: 'start', behavior: !switching && !reduceMotion ? 'smooth' : 'auto' });
    }
    updateHeader();
    requestAnimationFrame(() => { updateSpy(); checkReveals(); });
  }
  document.addEventListener('click', event => {
    const a = event.target.closest && event.target.closest('a[href^="#"]');
    if (!a || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    const href = a.getAttribute('href');
    if (href === location.hash || (href === '#home' && !location.hash)) { event.preventDefault(); route(true); }
  });
  window.addEventListener('hashchange', () => route(true));

  $('.skip').addEventListener('click', event => {
    event.preventDefault();
    const target = body.dataset.layout === 'docs' && activeSection ? ($('h2', activeSection) || $('#main')) : $('#main');
    target.focus();
  });
  $('#back-to-top').addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
    const h = activeSection && $('h2', activeSection); if (h) h.focus({ preventScroll: true });
  });

  /* ------------------------------------------------------------ Mobile menu */
  const sidebar = $('#sidebar'), overlay = $('#mobile-overlay'), menu = $('#menu-button');
  // While open, the drawer is modal: the page behind it is inert for keyboard and screen readers.
  const behindDrawer = () => [$('#main'), $('.site-footer')].filter(Boolean);
  function setDrawerModal(on) {
    if (on) { sidebar.setAttribute('role', 'dialog'); sidebar.setAttribute('aria-modal', 'true'); }
    else { sidebar.removeAttribute('role'); sidebar.removeAttribute('aria-modal'); }
    behindDrawer().forEach(el => { el.inert = on; });
  }
  function openMenu() {
    body.classList.add('nav-open'); menu.setAttribute('aria-expanded', 'true');
    setDrawerModal(true);
    const first = $('#toc a.active') || $('.drawer-tabs a') || $('#menu-close');
    setTimeout(() => first && first.focus({ preventScroll: true }), 50);
  }
  function closeMenu(restoreFocus) {
    if (!body.classList.contains('nav-open')) return;
    body.classList.remove('nav-open'); menu.setAttribute('aria-expanded', 'false');
    setDrawerModal(false);
    if (restoreFocus) menu.focus();
  }
  menu.addEventListener('click', () => body.classList.contains('nav-open') ? closeMenu(true) : openMenu());
  $('#menu-close').addEventListener('click', () => closeMenu(true));
  overlay.addEventListener('click', () => closeMenu(true));
  sidebar.addEventListener('keydown', event => {
    if (event.key !== 'Tab' || !body.classList.contains('nav-open')) return;
    const focusables = $$('a[href], button', sidebar).filter(el => el.offsetParent !== null);
    const first = focusables[0], last = focusables[focusables.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });

  /* ----------------------------------------------------------------- Search */
  const dialog = $('#search-dialog'), searchInput = $('#search-input'), results = $('#search-results'), searchStatus = $('#search-status');
  // Combobox pattern: the input keeps focus; aria-activedescendant names the result Enter opens.
  let optionSeq = 0;
  function setActive(link) {
    $$('a', results).forEach(a => { const on = a === link; a.classList.toggle('is-active', on); a.setAttribute('aria-selected', on ? 'true' : 'false'); });
    if (link) searchInput.setAttribute('aria-activedescendant', link.id); else searchInput.removeAttribute('aria-activedescendant');
  }
  const index = [];
  // Index what the reader sees in the content, not the injected code-panel chrome.
  // Two elements that touch with no text between them (a caption and its code, a node's title
  // and its note, table cells) are separate runs of text; code inside <pre> is left as written.
  // (On the Roadmap page that also leaves out metadata, tags, feature chips, runs of links, the
  // detail labels, the section counts and the screen-reader "To do".)
  const unindexed = '.code-head, .copy-button, .code-lang, .heading-anchor, .gx-meta, .gx-kind, .gx-chips, .gx-fx-m, .gx-fx-d, .gx-fx-c, .gx-catc, .gx-filter, .gx-bar, .gx-bar-h, .gx-bar-l, .gx-tl-s, .gx-meta-k, .gx-wf dt, .gx-wf > div:not(.rm-t) + div, .rm-sr, .rm-count';
  const indexText = el => {
    if (!el.querySelector) return el.textContent;
    if (el.matches(unindexed)) return '';
    const clone = el.cloneNode(true);
    $$(unindexed, clone).forEach(n => n.remove());
    $$('*', clone).forEach(n => { if (n.nextSibling && n.nextSibling.nodeType === 1 && !n.closest('pre')) n.after(' '); });
    return clone.textContent;
  };
  sections.forEach(section => {
    const page = pageOf.get(section.id);
    const secLabel = page === 'home' ? 'Overview' : navLabel(section);
    // The overview entry also carries the article's visible title and eyebrow, so a search
    // for the title ("Routes, redirects, and content types") finds the section itself.
    // The eyebrow (usually the group name) is searchable but earns no title bonus.
    const eyebrow = [...section.children].find(c => c.classList.contains('eyebrow'));
    const title = (section.dataset.title || '').replace(/\s+/g, ' ').trim();
    let bucket = { id: section.id, page, section: secLabel, name: page === 'home' ? '' : cardTitle(section), heading: '', title, text: eyebrow ? indexText(eyebrow) : '' };
    const flush = () => { bucket.text = bucket.text.replace(/\s+/g, ' ').trim(); if (bucket.text || !bucket.heading) index.push(bucket); };
    // On the Roadmap page an <h3> may sit inside a list item (a to-do); each one still starts its own
    // entry there. (The doc pages keep indexing their direct children only, as before.)
    const walk = parent => [...parent.children].forEach(child => {
      if (child.tagName === 'H3') { flush(); bucket = { id: child.id, page, section: secLabel, heading: child.dataset.title || child.textContent.trim(), title: '', text: '' }; }
      else if (page === 'roadmap' && child.querySelector('h3')) walk(child);
      else if (child.tagName !== 'H2' && !child.classList.contains('eyebrow')) bucket.text += ' ' + indexText(child);
    });
    walk(section);
    flush();
  });
  // Every row of the Roadmap's feature list is its own result, so a feature's name opens its row.
  $$('main .page[data-page="roadmap"] [id^="roadmap-f-"]').forEach(row => {
    const section = row.closest('main .page > section');
    if (!section) return;
    const named = $('h4', row);
    const heading = (named ? named.textContent : '').replace(/\s+/g, ' ').trim();
    if (!heading) return;
    const text = indexText(row).replace(/\s+/g, ' ').trim();
    index.push({ id: row.id, page: 'roadmap', section: navLabel(section), heading, title: '', text: text.startsWith(heading) ? text.slice(heading.length).trim() : text });
  });
  index.forEach(item => {
    item.hay = (item.section + ' ' + item.title + ' ' + item.heading + ' ' + item.text).toLowerCase();
    item.label = (item.section + ' ' + item.title).toLowerCase();
  });
  const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function highlightInto(el, text, words) {
    if (!words.length) { el.textContent = text; return; }
    const re = new RegExp('(' + words.map(escapeRe).join('|') + ')', 'gi');
    text.split(re).forEach((part, i) => {
      if (i % 2) { const m = document.createElement('mark'); m.textContent = part; el.append(m); }
      else if (part) el.append(document.createTextNode(part));
    });
  }
  const suggestions = ['quickstart', 'model', 'routing', 'preview', 'standalone', 'nextjs', 'walkthrough', 'troubleshooting'];
  function resultLink(item, words) {
    const a = document.createElement('a'); a.href = '#' + item.id;
    a.id = 'search-opt-' + (++optionSeq); a.setAttribute('role', 'option'); a.setAttribute('aria-selected', 'false');
    const ico = document.createElement('span'); ico.className = 'sr-icon'; ico.innerHTML = item.heading ? icon('hash') : icon('file');
    const bodyEl = document.createElement('span'); bodyEl.className = 'sr-body';
    const path = document.createElement('span'); path.className = 'sr-path';
    const group = groupOf.get(item.id);
    path.textContent = pageLabels[item.page] + (item.heading ? ' › ' + item.section : (group && group !== pageLabels[item.page] && group !== item.section ? ' › ' + group : ''));
    const title = document.createElement('span'); title.className = 'sr-title';
    highlightInto(title, item.heading || item.name || item.section, words);
    const enter = document.createElement('span'); enter.className = 'sr-enter'; enter.innerHTML = icon('corner');
    bodyEl.append(path, title);
    a.append(ico, bodyEl, enter);
    if (words.length) {
      const lower = item.text.toLowerCase();
      let at = -1; for (const w of words) { at = lower.indexOf(w); if (at >= 0) break; }
      if (at >= 0) {
        const start = Math.max(0, at - 48);
        const snip = document.createElement('span'); snip.className = 'sr-snip';
        highlightInto(snip, (start ? '…' : '') + item.text.slice(start, start + 180) + '…', words);
        bodyEl.append(snip);
      }
    }
    a.addEventListener('click', () => { dialog.close(); closeMenu(false); });
    return a;
  }
  function search(query) {
    results.replaceChildren();
    const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (!words.length) {
      const label = document.createElement('p'); label.className = 'search-label'; label.textContent = 'Suggested'; label.setAttribute('aria-hidden', 'true'); results.append(label);
      suggestions.forEach(id => { const item = index.find(i => i.id === id); if (item) results.append(resultLink(item, [])); });
      setActive($('a', results));
      searchInput.setAttribute('aria-expanded', 'true');
      searchStatus.textContent = '';
      return;
    }
    let scored = index.filter(item => words.every(w => item.hay.includes(w))).map(item => {
      let score = 0;
      words.forEach(w => {
        if (item.heading.toLowerCase().includes(w)) score += 6;
        if (item.section.toLowerCase().includes(w)) score += 4;
        else if (item.title.toLowerCase().includes(w)) score += 3;
        if (!item.heading && item.label.includes(w)) score += 8;
        score += Math.min(3, item.text.toLowerCase().split(w).length - 1);
      });
      if (item.page === 'home') score -= 3;
      return { item, score };
    }).sort((a, b) => b.score - a.score);
    // The Roadmap page's many items would crowd the docs out of a search made from the docs:
    // there, docs results come first and Roadmap ones follow (at least three kept).
    if (activePage !== 'roadmap') {
      const docs = scored.filter(s => s.item.page !== 'roadmap'), roadmap = scored.filter(s => s.item.page === 'roadmap');
      const mine = docs.slice(0, 20 - Math.min(3, roadmap.length));
      scored = mine.concat(roadmap.slice(0, 20 - mine.length));
    } else scored = scored.slice(0, 20);
    if (!scored.length) {
      const p = document.createElement('p'); p.className = 'search-empty';
      p.textContent = 'No matching sections. Try “schema”, “rollback”, or “TanStack”.';
      p.setAttribute('aria-hidden', 'true');
      results.append(p); setActive(null);
      searchInput.setAttribute('aria-expanded', 'false');
      searchStatus.textContent = 'No results.';
      return;
    }
    const count = document.createElement('p'); count.className = 'search-label'; count.setAttribute('aria-hidden', 'true');
    count.textContent = scored.length + (scored.length === 1 ? ' result' : ' results') + (scored.length === 20 ? ', best matches first' : '');
    results.append(count);
    scored.forEach(({ item }) => results.append(resultLink(item, words)));
    setActive($('a', results));
    searchInput.setAttribute('aria-expanded', 'true');
    searchStatus.textContent = count.textContent + '.';
  }
  function openSearch() {
    closeMenu(false);
    searchInput.value = ''; search('');
    if (!dialog.open) dialog.showModal();
    searchInput.focus();
  }
  $$('[data-search-open]').forEach(button => button.addEventListener('click', openSearch));
  $('#search-close').addEventListener('click', () => dialog.close());
  searchInput.addEventListener('input', () => search(searchInput.value));
  searchInput.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); dialog.close(); } });
  dialog.addEventListener('keydown', event => {
    const links = $$('a', results);
    if (!links.length) return;
    const i = links.indexOf(document.activeElement);
    const cur = links.findIndex(a => a.classList.contains('is-active'));
    const move = to => { setActive(links[to]); links[to].scrollIntoView({ block: 'nearest' }); return links[to]; };
    if (event.key === 'ArrowDown') { event.preventDefault(); const to = Math.min(links.length - 1, (i >= 0 ? i : cur) + 1); move(to).focus(); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); const from = i >= 0 ? i : cur; if (from <= 0) { move(0); searchInput.focus(); } else move(from - 1).focus(); }
    else if (event.key === 'Enter' && document.activeElement === searchInput) { event.preventDefault(); const target = links[cur >= 0 ? cur : 0]; if (target) target.click(); }
  });
  dialog.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const r = dialog.getBoundingClientRect();
    if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) dialog.close();
  });
  document.addEventListener('keydown', event => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); if (dialog.open) dialog.close(); else openSearch(); }
    else if (event.key === '/' && !typing && !dialog.open) { event.preventDefault(); openSearch(); }
    else if (event.key === 'Escape') closeMenu(true);
  });

  /* ---------------------------------------------------------- Scroll + print */
  let scheduled = false;
  function onScroll() { scheduled = false; updateSpy(); updateHeader(); checkReveals(); }
  window.addEventListener('scroll', () => { if (!scheduled) { scheduled = true; requestAnimationFrame(onScroll); } }, { passive: true });
  let fitTimer = 0;
  window.addEventListener('resize', () => {
    if (window.innerWidth >= 900) closeMenu(false);
    onScroll();
    clearTimeout(fitTimer);
    fitTimer = setTimeout(() => { if (activeSection && activeSection.id !== 'home') fitCode(activeSection); fadeToc(); }, 120);
  });
  $$('[data-print]').forEach(button => button.addEventListener('click', () => window.print()));
  $$('[data-copy-link]').forEach(button => button.addEventListener('click', async () => {
    const id = activeSection ? activeSection.id : 'home';
    const url = location.href.split('#')[0].split('?')[0] + '#' + id;
    const ok = await copyText(url);
    toast(ok ? 'Link copied' : 'Copy the address bar to share this page.');
  }));
  let printedDetails = [];
  window.addEventListener('beforeprint', () => { printedDetails = $$('details').map(el => [el, el.open]); printedDetails.forEach(([el]) => { el.open = true; }); });
  window.addEventListener('afterprint', () => printedDetails.forEach(([el, open]) => { el.open = open; }));

  /* ------------------------------------------------------- Landing: journey */
  // Baseline is what's committed on main; values are what the Studio form shows.
  const saved = { newCheckout: 10, stickyHeader: 50, freeShippingBanner: 0 };
  const expLabels = { newCheckout: 'new checkout', stickyHeader: 'sticky header', freeShippingBanner: 'free shipping banner' };
  const values = { newCheckout: 25, stickyHeader: 50, freeShippingBanner: 0 };
  const jsonCode = $('#exp-json');
  const expFoot = $('#exp-foot');
  const saveBtn = $('#studio-save');
  let lastCommit = '';
  function commitMessage() {
    const changed = Object.keys(saved).filter(k => values[k] !== saved[k]);
    if (changed.length === 1) { const k = changed[0]; return (values[k] > saved[k] ? 'ramp ' : 'lower ') + expLabels[k] + ' to ' + values[k] + '%'; }
    return changed.length ? 'update ' + changed.length + ' experiments' : '';
  }
  function renderJson(changedKey) {
    if (!jsonCode) return;
    const keys = Object.keys(saved);
    const line = (cls, gut, inner) => '<span class="dl' + (cls ? ' ' + cls : '') + '"><span class="gut">' + gut + '</span>' + inner + '</span>';
    const prop = (k, v, comma) => '  <span class="tk-p">"' + k + '"</span>: <span class="tk-n">' + v + '</span>' + comma;
    let html = line('', ' ', '{') + line('', ' ', '  <span class="tk-p">"__resolveType"</span>: <span class="tk-s">"experiments"</span>,');
    keys.forEach((k, i) => {
      const comma = i < keys.length - 1 ? ',' : '';
      if (values[k] !== saved[k]) {
        html += line('del', '-', prop(k, saved[k], comma));
        html += line('add' + (k === changedKey ? ' flash' : ''), '+', prop(k, values[k], comma));
      } else html += line('', ' ', prop(k, values[k], comma));
    });
    html += line('', ' ', '}');
    jsonCode.innerHTML = html;
    const changed = keys.filter(k => values[k] !== saved[k]).length;
    if (changed) {
      expFoot.dataset.state = 'dirty';
      $('#exp-status').textContent = changed + (changed === 1 ? ' change' : ' changes') + ' · not committed yet';
      $('#exp-commit').textContent = commitMessage();
    } else if (lastCommit) {
      expFoot.dataset.state = 'committed';
      $('#exp-status').textContent = 'Committed';
      $('#exp-commit').textContent = lastCommit;
    } else {
      expFoot.dataset.state = 'clean';
      $('#exp-status').textContent = 'No changes';
      $('#exp-commit').textContent = 'up to date with main';
    }
    if (saveBtn) { saveBtn.disabled = !changed; saveBtn.textContent = changed ? 'Save' : 'Saved'; }
    $('#exp-odds').textContent = values.newCheckout;
  }
  $$('.studio input[type="range"]').forEach(input => {
    const key = input.dataset.exp;
    const out = byId('out-' + key);
    const sync = () => {
      values[key] = Number(input.value);
      input.style.setProperty('--val', input.value + '%');
      out.textContent = input.value;
      renderJson(key);
    };
    input.addEventListener('input', sync);
  });
  renderJson();
  if (saveBtn) saveBtn.addEventListener('click', () => {
    const message = commitMessage();
    if (!message) return;
    lastCommit = message;
    Object.assign(saved, values);
    renderJson();
    expFoot.classList.remove('just'); void expFoot.offsetWidth; expFoot.classList.add('just');
    toast('In Studio, Save commits the file to your repository.');
  });
  $$('[data-copy]').forEach(button => button.addEventListener('click', async () => {
    const ok = await copyText(button.dataset.copy);
    toast(ok ? 'Copied: ' + button.dataset.copy : 'Select the text to copy it.');
    if (ok) { button.classList.add('copied'); setTimeout(() => button.classList.remove('copied'), 1600); }
  }));

  /* ------------------------------------- Landing: journey carousel (phones) */
  // Below 768px the four panels become one scroll-snap row; the step pills follow and drive it.
  const journey = $('.journey');
  const jpSteps = $$('.journey-nav [data-jp]');
  if (journey && jpSteps.length) {
    const panels = $$('.jp', journey);
    const markStep = i => jpSteps.forEach((b, j) => { if (j === i) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
    let jpTick = false;
    journey.addEventListener('scroll', () => {
      if (jpTick) return; jpTick = true;
      requestAnimationFrame(() => {
        jpTick = false;
        const left = journey.scrollLeft, pad = parseFloat(getComputedStyle(journey).paddingLeft) || 0;
        let best = 0, dist = Infinity;
        panels.forEach((p, i) => { const d = Math.abs(p.offsetLeft - pad - left); if (d < dist) { dist = d; best = i; } });
        if (journey.scrollLeft + journey.clientWidth >= journey.scrollWidth - 2) best = panels.length - 1;
        markStep(best);
      });
    }, { passive: true });
    const showPanel = i => {
      const pad = parseFloat(getComputedStyle(journey).paddingLeft) || 0;
      journey.scrollTo({ left: panels[i].offsetLeft - pad, behavior: reduceMotion ? 'auto' : 'smooth' });
      markStep(i);
    };
    jpSteps.forEach((b, i) => b.addEventListener('click', () => showPanel(i)));
    journey.addEventListener('focusin', event => {
      if (journey.scrollWidth <= journey.clientWidth + 1) return;
      const i = panels.findIndex(p => p.contains(event.target));
      if (i < 0) return;
      const box = journey.getBoundingClientRect(), r = panels[i].getBoundingClientRect();
      if (r.left < box.left - 1 || r.right > box.right + 1) showPanel(i);
    });
  }

  /* ------------------------------------------------------- Landing: stepper */
  const stepTabs = $$('.stepper [role="tab"]');
  function selectStep(n, focus) {
    stepTabs.forEach(tab => {
      const on = tab.dataset.step === String(n);
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    $$('.sw-pane').forEach(pane => pane.classList.toggle('is-on', pane.id === 'step-pane-' + n));
    $$('.sw-tab').forEach(t => t.classList.toggle('is-on', t.dataset.step === String(n)));
  }
  stepTabs.forEach((tab, i) => {
    tab.addEventListener('click', () => selectStep(tab.dataset.step));
    tab.addEventListener('keydown', event => {
      const k = event.key;
      let to = null;
      if (k === 'ArrowDown' || k === 'ArrowRight') to = (i + 1) % stepTabs.length;
      else if (k === 'ArrowUp' || k === 'ArrowLeft') to = (i - 1 + stepTabs.length) % stepTabs.length;
      else if (k === 'Home') to = 0; else if (k === 'End') to = stepTabs.length - 1;
      if (to !== null) { event.preventDefault(); selectStep(stepTabs[to].dataset.step, true); }
    });
  });
  $$('.sw-tab').forEach(t => t.addEventListener('click', () => selectStep(t.dataset.step)));

  /* ------------------------------------------------ Walkthrough */
  const traceCode = $('#trace-code');
  if (traceCode) {
    let mode = 'data', operation = 'resolve', step = 0;
    const product = { name: 'Summer shirt', price: 49 };
    const stored = { __resolveType: 'product-card', title: 'Summer collection', product: { __resolveType: 'CurrentProduct' } };
    const expanded = { __resolveType: 'product-card', title: 'Summer collection', product: { __resolveType: 'catalog-product', slug: 'summer-shirt' } };
    const children = { __resolveType: 'product-card', title: 'Summer collection', product };
    const stringify = value => JSON.stringify(value, null, 2);
    const captions = {
      resolve: [
        'The saved entry. Its product input names CurrentProduct, another saved entry.',
        'CurrentProduct is a saved entry, so it\'s replaced with its JSON, and the rule runs again on what came back.',
        'catalog-product is a function. Its inputs hold no more blocks, so it runs, and the product data takes its place.',
        'product-card is a function. Its inputs are all values now, so it runs. The CMS never looks inside what it returns.',
      ],
      get: [
        'The saved entry. Its product input names CurrentProduct, another saved entry.',
        'Reading without running: saved entries still expand, so CurrentProduct is replaced with its JSON. catalog-product and product-card name functions, so they come back as JSON, untouched. No code runs.',
      ],
    };
    const stats = {
      resolve: ['0 function calls', '0 function calls · entry expanded', '1 function call · catalog-product', '2 function calls · result returned as is'],
      get: ['0 function calls', '0 function calls · final value'],
    };
    function renderTrace() {
      const last = captions[operation].length - 1;
      step = Math.min(step, last);
      $$('[data-trace-mode]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.traceMode === mode)));
      $$('[data-trace-operation]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.traceOperation === operation)));
      $$('[data-trace-step]').forEach(button => { button.setAttribute('aria-current', Number(button.dataset.traceStep) === step ? 'step' : 'false'); button.disabled = Number(button.dataset.traceStep) > last; });
      let code = [stored, expanded, children][step] && stringify([stored, expanded, children][step]);
      let language = 'json';
      if (step === 3) {
        if (mode === 'data') code = stringify({ component: 'ProductCard', props: { title: 'Summer collection', product } });
        else { code = '<ProductCard\n  title="Summer collection"\n  product={{ name: "Summer shirt", price: 49 }}\n/>'; language = 'tsx'; }
      }
      traceCode.textContent = code;
      highlightCode(traceCode, language);
      $('#trace-caption').textContent = captions[operation][step];
      $('#trace-stat').textContent = stats[operation][step];
      $('#trace-next').disabled = step === last;
    }
    $$('[data-trace-mode]').forEach(button => button.addEventListener('click', () => { mode = button.dataset.traceMode; renderTrace(); }));
    $$('[data-trace-operation]').forEach(button => button.addEventListener('click', () => { operation = button.dataset.traceOperation; step = 0; renderTrace(); }));
    $$('[data-trace-step]').forEach(button => button.addEventListener('click', () => { step = Number(button.dataset.traceStep); renderTrace(); }));
    $('#trace-next').addEventListener('click', () => { step += 1; renderTrace(); });
    renderTrace();
  }

  /* ------------------------------------------------------------------- Boot */
  route(false);
  // Web fonts can reflow the article after the first scroll; re-anchor a deep link once they're in,
  // unless the reader has already started scrolling.
  let userMoved = false;
  ['wheel', 'touchmove', 'keydown', 'mousedown'].forEach(type => window.addEventListener(type, () => { userMoved = true; }, { passive: true, once: true }));
  const reanchor = () => {
    if (activeSection && activeSection.id !== 'home') fitCode(activeSection);
    fadeToc();
    if (!userMoved) {
      const target = byId(currentId());
      if (target && activeSection && target !== activeSection && activeSection.contains(target)) target.scrollIntoView({ block: 'start' });
    }
    requestAnimationFrame(updateSpy);
  };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(reanchor);
  window.addEventListener('load', reanchor);
})();
