// Zo Co-browse — Content Script
// Captures page context and executes browser actions

(function () {
  const PAGE_DEAD = /^(about:|chrome-extension:|file:)/;

  function isAlive() {
    return !PAGE_DEAD.test(location.protocol);
  }

  /** Grab structured page context for Zo's AI.
   *  tier 0 = URL/title/viewport only; 1 = +visibleText; 2 = +clickable+forms.
   *  (Screenshots for tier 3 are captured separately by the background.)
   *  opts.pull — capture-shape hint from the pull loop (#24): 'page' raises
   *  the text cap (read_page), 'dom' raises element caps (get_dom), 'form'
   *  returns all form fields (get_form). */
  function captureContext(tier, opts) {
    const t = (typeof tier === 'number' && tier >= 0 && tier <= 3) ? tier : 2;
    const pull = opts && typeof opts.pull === 'string' ? opts.pull : null;
    const maxTextLen = pull === 'page' ? 20000 : 8000;
    const doc = document;

    const base = {
      url: location.href,
      title: doc.title,
      viewport: { w: window.innerWidth, h: window.innerHeight },
    };
    if (t === 0) return base;

    // Structured visible text — prefer <main>/<article>, fallback to body
    const mainEl = doc.querySelector('main, article, [role="main"], #content, .content');
    const bodyText = (mainEl || doc.body)?.innerText || '';
    const visibleText = bodyText.substring(0, maxTextLen);
    const out = { ...base, visibleText };
    if (t === 1) return out;

    // Form field summary (for fill actions)
    const formFields = [];
    doc.querySelectorAll('input, textarea, select').forEach((el) => {
      if (el.type === 'hidden') return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      formFields.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || 'text',
        name: el.name || el.id || '',
        selector: buildSelector(el),
        placeholder: el.placeholder || '',
        question: nearestQuestion(el),
        value: el.value?.substring(0, 100) || '',
      });
    });

    // Interactive elements map (for click targeting)
    const clickableEls = [];
    doc.querySelectorAll('a, button, [role="button"], [onclick], input[type="submit"], input[type="button"]').forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      const text = (el.textContent || el.value || '').trim().substring(0, 60);
      if (!text) return;
      clickableEls.push({ text, tag: el.tagName.toLowerCase(), selector: buildSelector(el) });
    });

    out.formFields = formFields.slice(0, pull === 'form' ? 300 : pull === 'dom' ? 150 : 30);
    out.clickable = clickableEls.slice(0, pull === 'dom' ? 200 : 50);
    out.documentSize = { w: doc.documentElement.scrollWidth, h: doc.documentElement.scrollHeight };
    return out;
  }

  /** Build a simple CSS selector for an element */
  function buildSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name && el.tagName.match(/^(INPUT|TEXTAREA|SELECT)$/i))
      return `${el.tagName.toLowerCase()}[name="${CSS.escape(el.name)}"]`;
    let sel = el.tagName.toLowerCase();
    if (el.className && typeof el.className === 'string') {
      const classes = el.className.trim().split(/\s+/).filter(Boolean).slice(0, 3);
      if (classes.length) sel += classes.map((c) => `.${CSS.escape(c)}`).join('');
    }
    // Disambiguate with nth-child if ambiguous
    const parent = el.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        (s) => s.tagName === el.tagName
      );
      if (siblings.length > 1) {
        const idx = siblings.indexOf(el) + 1;
        sel += `:nth-child(${idx})`;
      }
    }
    return sel;
  }

  /** Wait for an element to appear in DOM */
  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const el = document.querySelector(selector);
      if (el) return resolve(el);
      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        reject(new Error(`Element not found: ${selector}`));
      }, timeout);
    });
  }

  /** Prefer the candidate the user can actually see — long/SPA forms keep
   *  every section's fields in the DOM at once (builder-style forms), so
   *  equal cues must resolve to the field on screen, not the first in
   *  document order. Falls back to document order when none intersect. */
  function pickVisible(fields) {
    for (const f of fields) {
      const r = f.getBoundingClientRect();
      if (r.top < window.innerHeight && r.bottom > 0) return f;
    }
    return fields[0] || null;
  }

  /** Question-scoped resolution for builder-style forms (Typeform et al.):
   *  inputs carry no label/name and share an identical placeholder, but each
   *  question's title text sits near its field. A cue matches a text element
   *  (heading/legend/label-like leaf) exactly; the field associates by shared
   *  wrapper — climb from the cue until its subtree contains a field. */
  function resolveByQuestion(t) {
    const want = normCue(t);
    const cues = [];
    for (const el of document.querySelectorAll('h1,h2,h3,h4,h5,h6,legend,label,p,span,div,td,th,fieldset')) {
      if (el.querySelector('input, textarea, select')) continue; // a wrapper, not a cue
      const txt = (el.innerText || '').trim();
      if (!txt || txt.length > 160) continue;
      if (normCue(txt) !== want) continue;
      cues.push(el);
    }
    const candidates = [];
    for (const cue of cues) {
      let scope = cue;
      for (let i = 0; i < 8 && scope; i++) {
        const inner = scope.querySelector('input, textarea, select');
        if (inner) { candidates.push(inner); break; }
        scope = scope.parentElement;
      }
    }
    return candidates.length ? pickVisible(candidates) : null;
  }

  /** Cue normalization — builder forms decorate titles ("First name*",
   *  "Email:") and Zo's target may or may not carry the decoration. */
  function normCue(s) {
    return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ').replace(/[:*]+$/, '').trim();
  }

  /** Nearest question title for a field, generic across builders: explicit
   *  label/aria first, then the title-above-field convention — climb from the
   *  field and read the nearest preceding sibling's text (live-verified on a
   *  Typeform: the question is a plain div, the input wrapper's prev sibling).
   *  Feeds `formFields[].question` so Zo can target fill_form by question text
   *  when placeholders collide. */
  function nearestQuestion(el) {
    const id = el.id;
    if (id) {
      const lab = document.querySelector(`label[for="${CSS.escape(id)}"]`);
      if (lab && (lab.textContent || '').trim()) return lab.textContent.trim().slice(0, 120);
    }
    const aria = (el.getAttribute('aria-label') || '').trim();
    if (aria) return aria.slice(0, 120);
    let scope = el;
    for (let i = 0; i < 8 && scope; i++) {
      let sib = scope.previousElementSibling;
      while (sib) {
        const txt = (sib.innerText || '').trim();
        if (txt && txt.length <= 160 && !/^(ok|next|submit|start|back)$/i.test(txt) &&
            !sib.querySelector('button, a[href], input, textarea, select')) {
          return txt.replace(/\s+/g, ' ').slice(0, 120);
        }
        sib = sib.previousElementSibling;
      }
      scope = scope.parentElement;
    }
    return '';
  }

  /** Resolve a fill_form target to a field element: CSS selector fallback
   *  first, then label text (for=/nested), aria-label/labelledby, placeholder,
   *  name, id — the human cues get_form surfaced to Zo — then question text
   *  for builder-style forms, with viewport preference for equal cues. */
  function resolveFieldTarget(target, selector) {
    if (selector) {
      const el = document.querySelector(selector);
      if (el) return el;
    }
    const t = String(target || '').trim().toLowerCase();
    if (!t) return null;
    const fields = Array.from(document.querySelectorAll('input, textarea, select'))
      .filter((f) => f.type !== 'hidden');
    for (const label of document.querySelectorAll('label')) {
      if ((label.textContent || '').trim().toLowerCase() !== t) continue;
      const forEl = label.htmlFor ? document.getElementById(label.htmlFor) : null;
      const inner = label.querySelector('input, textarea, select');
      const el = forEl || inner;
      if (el) return el;
    }
    const byAria = fields.filter((f) =>
      (f.getAttribute('aria-label') || '').trim().toLowerCase() === t ||
      (f.getAttribute('aria-labelledby') || '').trim().split(/\s+/).some((id) => {
        const lab = id && document.getElementById(id);
        return lab && (lab.textContent || '').trim().toLowerCase() === t;
      }));
    if (byAria.length) return byAria[0];
    const byAttr = fields.filter((f) =>
      (f.placeholder || '').trim().toLowerCase() === t ||
      (f.name || '').toLowerCase() === t ||
      (f.id || '').toLowerCase() === t);
    if (byAttr.length) return pickVisible(byAttr);
    return resolveByQuestion(t);
  }

  /** Check whether a string is a valid CSS selector (guards against
   *  Playwright pseudo-selectors like :has-text()/:text() that Zo may
   *  emit — those throw in document.querySelector). */
  function isValidCssSelector(sel) {
    if (!sel || typeof sel !== 'string') return false;
    // Reject known non-CSS pseudo-selectors up front.
    if (/:has-text|:text\(|:has\(/i.test(sel)) return false;
    try { document.querySelector(sel); return true; }
    catch { return false; }
  }

  /** Resolve a click target: pure CSS selector preferred, but fall back to
   *  text matching when Zo emits Playwright-style :has-text("…") selectors.
   *  Returns an element or null. */
  function resolveClickTarget(selector) {
    if (!selector) return null;
    // Fast path: valid CSS.
    if (isValidCssSelector(selector)) return document.querySelector(selector);
    // Extract text from Playwright :has-text("…") / :text("…").
    const m = selector.match(/:has-text\(\s*["']([^"']+)["']\s*\)|:text\(\s*["']([^"']+)["']\s*\)/i);
    const txt = m ? (m[1] || m[2]) : null;
    if (txt) {
      const norm = txt.toLowerCase().trim();
      for (const el of document.querySelectorAll('a, button, [role=button], [onclick], input[type=submit], input[type=button], [type=submit]')) {
        if ((el.textContent || '').trim().toLowerCase().includes(norm)) return el;
      }
    }
    return null;
  }

  /** Set a select value; Zo usually sends the visible OPTION TEXT ("Visa
   *  (Preferred)") while el.value assignment matches the value attr ("visa")
   *  — fall back to text matching when the direct set selects nothing. */
  function setFieldValue(el, val) {
    el.focus();
    el.value = '';
    el.value = val;
    if (el.tagName === 'SELECT' && el.selectedIndex === -1) {
      const want = String(val == null ? '' : val).trim().toLowerCase();
      if (want) {
        const opts = Array.from(el.options || []);
        const opt = opts.find((o) => (o.textContent || '').trim().toLowerCase() === want) ||
          opts.find((o) => (o.textContent || '').trim().toLowerCase().startsWith(want));
        if (opt) el.value = opt.value;
      }
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Execute a single action */
  async function executeAction(action) {
    switch (action.type) {
      case 'click': {
        const el = resolveClickTarget(action.selector) || await waitForElement(
          isValidCssSelector(action.selector) ? action.selector : ''
        );
        if (!el) throw new Error(`Element not found: ${action.selector}`);
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(300);
        el.click();
        return { ok: true, type: 'click' };
      }
      case 'fill': {
        const el = (await waitForElement(action.selector))
        setFieldValue(el, action.value);
        return { ok: true, type: 'fill' };
      }
      case 'fill_form': {
        const results = [];
        for (const entry of action.values || []) {
          const el = resolveFieldTarget(entry.target, entry.selector);
          if (!el) { results.push({ ok: false, target: entry.target, error: 'no field matched' }); continue; }
          setFieldValue(el, String(entry.value == null ? '' : entry.value));
          results.push({ ok: true, target: entry.target, type: el.type || el.tagName.toLowerCase() });
        }
        const failed = results.filter((r) => !r.ok);
        return {
          ok: failed.length === 0,
          type: 'fill_form',
          fields: results,
          ...(failed.length ? { error: `${failed.length} field(s) unmatched: ${failed.map((f) => f.target).join(', ')}` } : {}),
        };
      }
      case 'extract': {
        const el = await waitForElement(action.selector);
        const val = action.attribute
          ? el.getAttribute(action.attribute)
          : el.textContent?.trim();
        return { ok: true, type: 'extract', value: val || '' };
      }
      case 'scroll': {
        const amount = action.amount || window.innerHeight * 0.7;
        const x = 0;
        const y = action.direction === 'up' ? -amount : amount;
        window.scrollBy({ left: x, top: y, behavior: 'smooth' });
        return { ok: true, type: 'scroll' };
      }
      case 'wait':
        await sleep(action.ms || 1000);
        return { ok: true, type: 'wait' };
      case 'navigate':
        // Navigation is normally handled by the background (chrome.tabs.update),
        // but accept it here as a no-op success so a forwarded action never
        // reports a false failure.
        return { ok: true, type: 'navigate' };
      case 'done':
        // Terminal action — no DOM work, just signal completion.
        return { ok: true, type: 'done', response: action.response || '' };
      default:
        return { ok: false, error: `Unknown action type: ${action.type}` };
    }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- Write-assist widget (feature/textarea-fill) -------------------------
  // First page-injected UI in this extension: a floating Zo icon on a focused
  // <textarea> that asks the background to enhance the lead text (ENHANCE_TEXT)
  // and previews the result before filling it back. All AI logic (prompt build,
  // response parse) lives in the background + lib/write-assist; this section is
  // DOM-only. It is also the first content->background message initiator.
  //
  // MV3 content scripts are classic (non-module) scripts, so this cannot import
  // lib/write-assist; it mirrors the trivial eligibility predicate inline and
  // delegates everything else to the background.

  const WA_ICON_BOX = 22;      // icon button outer size (px)
  const WA_GRACE_MS = 150;     // blur grace before hiding the icon

  const WA_CSS = `
    :host { all: initial; }
    [hidden] { display: none !important; }
    .zo-wa-icon {
      position: fixed; display: none; width: ${WA_ICON_BOX}px; height: ${WA_ICON_BOX}px;
      padding: 2px; box-sizing: border-box; align-items: center; justify-content: center;
      background: #fff; border: 1px solid #d0d5dd; border-radius: 6px;
      box-shadow: 0 1px 4px rgba(16,24,40,.25); cursor: pointer;
      pointer-events: auto; z-index: 2147483647;
    }
    .zo-wa-icon:hover { border-color: #2962b8; }
    .zo-wa-icon img { width: 16px; height: 16px; display: block; }
    .zo-wa-pop {
      position: fixed; width: 340px; max-width: calc(100vw - 16px);
      background: #fff; color: #101828; border: 1px solid #d0d5dd; border-radius: 10px;
      box-shadow: 0 8px 24px rgba(16,24,40,.2); pointer-events: auto; z-index: 2147483647;
      font: 13px/1.45 -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
      display: flex; flex-direction: column; overflow: hidden;
    }
    .zo-wa-head { display: flex; align-items: center; justify-content: space-between;
      padding: 8px 10px; border-bottom: 1px solid #eaecf0; background: #f8fafc; }
    .zo-wa-title { display: flex; align-items: center; gap: 6px; font-weight: 600; }
    .zo-wa-title-img { width: 16px; height: 16px; }
    .zo-wa-x { border: 0; background: transparent; cursor: pointer; color: #667085;
      font-size: 13px; line-height: 1; padding: 2px 4px; border-radius: 4px; }
    .zo-wa-x:hover { background: #eaecf0; color: #101828; }
    .zo-wa-lead { padding: 8px 10px 0; color: #475467; font-style: italic;
      max-height: 54px; overflow: hidden; }
    .zo-wa-instr { margin: 8px 10px 0; padding: 6px 8px; border: 1px solid #d0d5dd;
      border-radius: 6px; font: inherit; width: calc(100% - 20px); box-sizing: border-box; }
    .zo-wa-instr:focus { outline: 2px solid #2962b8; border-color: #2962b8; }
    .zo-wa-body { padding: 10px; overflow-y: auto; max-height: 180px; white-space: pre-wrap; }
    .zo-wa-loading { display: flex; align-items: center; color: #475467; max-height: none; }
    .zo-wa-spin { width: 14px; height: 14px; border: 2px solid #d0d5dd;
      border-top-color: #2962b8; border-radius: 50%; animation: zo-wa-rot .8s linear infinite; }
    @keyframes zo-wa-rot { to { transform: rotate(360deg); } }
    .zo-wa-error { color: #b42318; }
    .zo-wa-note { padding: 0 10px 6px; color: #b54708; font-size: 12px; }
    .zo-wa-foot { display: flex; align-items: center; gap: 8px; padding: 8px 10px;
      border-top: 1px solid #eaecf0; }
    .zo-wa-spacer { flex: 1; }
    .zo-wa-btn { padding: 6px 12px; border: 1px solid #d0d5dd; border-radius: 6px;
      background: #fff; cursor: pointer; font: inherit; color: #344054; }
    .zo-wa-btn:hover { background: #f2f4f7; }
    .zo-wa-primary { background: #2962b8; border-color: #2962b8; color: #fff; }
    .zo-wa-primary:hover { background: #1f4f96; }
  `;

  let waEnabled = true;      // enableWriteAssist setting (default on)
  let waReady = false;       // widget DOM built
  let waHost = null, waRoot = null, waIcon = null, waPop = null;
  let waActiveEl = null;     // textarea the icon/popover is anchored to
  let waReqId = 0;           // stale-response guard
  let waHideTimer = null;
  let waView = { mode: 'compose', result: '', error: '', instruction: '' };

  function waAvailable() {
    try {
      return typeof chrome !== 'undefined' &&
        !!(chrome.storage && chrome.storage.sync) &&
        !!(chrome.runtime && chrome.runtime.sendMessage);
    } catch { return false; }
  }

  /** Mirror of lib/write-assist.js#isEnhanceableField (content scripts can't import).
   *  Textareas plus contenteditable rich editors (CodeMirror — GitHub's new
   *  issue form — ProseMirror, Lexical…). */
  function waEligible(el) {
    if (!el) return false;
    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
    return !!el.isContentEditable;
  }

  /** Current text of an enhanceable field (textarea value / editor innerText). */
  function waGetText(el) {
    if (!el) return '';
    if (el.isContentEditable) return String(el.innerText || el.textContent || '');
    return String(el.value || '');
  }

  function waFieldInfo(el) {
    const ce = !!el.isContentEditable;
    let placeholder = el.placeholder || '';
    if (ce) {
      placeholder = el.getAttribute('aria-placeholder') ||
        (el.closest && el.closest('[data-placeholder]')?.getAttribute('data-placeholder')) || '';
    }
    return {
      label: nearestQuestion(el) || '',
      placeholder,
      maxLength: (!ce && typeof el.maxLength === 'number' && el.maxLength > 0) ? el.maxLength : null,
      markdown: ce, // contenteditable editors (GitHub et al.) render Markdown; plain textareas don't
    };
  }

  function waEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text != null) el.textContent = text;
    return el;
  }

  function waBuild() {
    if (waReady) return;
    waHost = document.createElement('div');
    waHost.id = 'zo-write-assist-host';
    waHost.style.cssText = 'position:fixed; top:0; left:0; pointer-events:none; z-index:2147483647;';
    waRoot = waHost.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = WA_CSS;
    waRoot.appendChild(style);

    waIcon = document.createElement('button');
    waIcon.type = 'button';
    waIcon.className = 'zo-wa-icon';
    waIcon.title = 'Enhance with Zo';
    waIcon.setAttribute('aria-label', 'Enhance with Zo');
    waIcon.tabIndex = 0;
    const img = document.createElement('img');
    try { img.src = chrome.runtime.getURL('icons/icon.svg'); } catch { /* no getURL */ }
    img.alt = '';
    waIcon.appendChild(img);
    waIcon.addEventListener('click', (e) => { e.stopPropagation(); waOpen(); });
    waRoot.appendChild(waIcon);

    waPop = document.createElement('div');
    waPop.className = 'zo-wa-pop';
    waPop.hidden = true;
    waRoot.appendChild(waPop);

    (document.documentElement || document.body).appendChild(waHost);
    waReady = true;
  }

  function waShowIcon() {
    if (!waReady || !waActiveEl) return;
    const rect = waActiveEl.getBoundingClientRect();
    if (!rect || (rect.width === 0 && rect.height === 0)) return;
    waIcon.style.top = Math.max(4, rect.bottom - WA_ICON_BOX - 4) + 'px';
    waIcon.style.left = Math.max(4, rect.right - WA_ICON_BOX - 4) + 'px';
    waIcon.style.display = 'flex';
  }

  function waHideIcon() {
    if (waIcon) waIcon.style.display = 'none';
  }

  /** Anchor the popover INSIDE the field's own box whenever the field is tall
   *  enough (bottom-aligned, near the icon) — it then never covers page
   *  content outside the field and never extends past the viewport, so opening
   *  it forces no scroll. Small fields fall back to below (flipping above,
   *  viewport-clamped). */
  function waPositionPop() {
    if (!waActiveEl || !waPop) return;
    const rect = waActiveEl.getBoundingClientRect();
    const pw = waPop.offsetWidth || 340;
    const ph = waPop.offsetHeight || 200;
    const m = 8; // inset from the field's edges / viewport
    let top;
    let left;
    if (rect.height >= ph + m * 2) {
      // Inside the field, bottom-aligned; clamp to what's actually visible so
      // a field taller than the viewport keeps the popover fully on screen.
      top = rect.bottom - m - ph;
      if (top + ph > window.innerHeight - m) top = window.innerHeight - m - ph;
      if (top < rect.top + m) top = rect.top + m;
      left = rect.left + m;
    } else {
      top = rect.bottom + m;
      left = rect.left;
      if (top + ph > window.innerHeight - m) top = Math.max(m, rect.top - ph - m);
    }
    if (left + pw > window.innerWidth - m) left = Math.max(m, window.innerWidth - pw - m);
    if (top < m) top = m;
    waPop.style.top = top + 'px';
    waPop.style.left = left + 'px';
  }

  function waOpen() {
    if (!waReady || !waActiveEl) return;
    if (waHideTimer) { clearTimeout(waHideTimer); waHideTimer = null; }
    waView = { mode: 'compose', result: '', error: '', instruction: waView.instruction || '' };
    waPop.hidden = false; // shown before render so waRender can measure + position
    waRender();
  }

  function waClose() {
    waReqId++; // invalidate any in-flight response
    if (waPop) waPop.hidden = true;
    waView = { mode: 'compose', result: '', error: '', instruction: '' };
    if (waEligible(document.activeElement)) { waActiveEl = document.activeElement; waShowIcon(); }
    else waHideIcon();
  }

  function waRender() {
    waPop.textContent = '';
    const head = waEl('div', 'zo-wa-head');
    const title = waEl('div', 'zo-wa-title');
    const timg = document.createElement('img');
    try { timg.src = chrome.runtime.getURL('icons/icon.svg'); } catch { /* no getURL */ }
    timg.alt = '';
    timg.className = 'zo-wa-title-img';
    title.appendChild(timg);
    title.appendChild(document.createTextNode('Enhance with Zo'));
    const close = waEl('button', 'zo-wa-x');
    close.type = 'button';
    close.textContent = '\u2715';
    close.title = 'Close';
    close.addEventListener('click', () => waClose());
    head.appendChild(title);
    head.appendChild(close);
    waPop.appendChild(head);

    if (waView.mode === 'compose') {
      const lead = waEl('div', 'zo-wa-lead');
      const leadTxt = waGetText(waActiveEl).trim();
      lead.textContent = leadTxt
        ? (leadTxt.length > 140 ? leadTxt.slice(0, 140) + '\u2026' : leadTxt)
        : '(empty field \u2014 Zo will draft from your instruction)';
      waPop.appendChild(lead);
      const instr = document.createElement('input');
      instr.type = 'text';
      instr.className = 'zo-wa-instr';
      instr.placeholder = 'Optional instruction \u2014 tone, length, focus\u2026';
      instr.value = waView.instruction || '';
      waPop.appendChild(instr);
      const foot = waEl('div', 'zo-wa-foot');
      foot.appendChild(waEl('div', 'zo-wa-spacer'));
      const btn = waEl('button', 'zo-wa-btn zo-wa-primary');
      btn.type = 'button';
      btn.textContent = 'Enhance';
      btn.addEventListener('click', () => { waView.instruction = instr.value; waEnhance(); });
      instr.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { waView.instruction = instr.value; waEnhance(); }
      });
      foot.appendChild(btn);
      waPop.appendChild(foot);
    } else if (waView.mode === 'loading') {
      const body = waEl('div', 'zo-wa-body zo-wa-loading');
      body.appendChild(waEl('div', 'zo-wa-spin'));
      body.appendChild(document.createTextNode(' Zo is writing\u2026'));
      waPop.appendChild(body);
      const foot = waEl('div', 'zo-wa-foot');
      const cancel = waEl('button', 'zo-wa-btn');
      cancel.type = 'button';
      cancel.textContent = 'Cancel';
      cancel.addEventListener('click', () => waClose());
      foot.appendChild(cancel);
      waPop.appendChild(foot);
    } else if (waView.mode === 'result') {
      const body = waEl('div', 'zo-wa-body zo-wa-result');
      body.textContent = waView.result;
      waPop.appendChild(body);
      const ml = waActiveEl && typeof waActiveEl.maxLength === 'number' ? waActiveEl.maxLength : -1;
      if (ml > 0 && waView.result.length > ml) {
        waPop.appendChild(waEl('div', 'zo-wa-note', `Longer than the field's ${ml}-character limit.`));
      }
      const foot = waEl('div', 'zo-wa-foot');
      const retry = waEl('button', 'zo-wa-btn');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => waEnhance());
      const accept = waEl('button', 'zo-wa-btn zo-wa-primary');
      accept.type = 'button';
      accept.textContent = 'Accept';
      accept.addEventListener('click', () => waAccept());
      foot.appendChild(retry);
      foot.appendChild(accept);
      waPop.appendChild(foot);
    } else if (waView.mode === 'error') {
      waPop.appendChild(waEl('div', 'zo-wa-body zo-wa-error', waView.error || 'Something went wrong.'));
      const foot = waEl('div', 'zo-wa-foot');
      const retry = waEl('button', 'zo-wa-btn');
      retry.type = 'button';
      retry.textContent = 'Retry';
      retry.addEventListener('click', () => waEnhance());
      foot.appendChild(retry);
      waPop.appendChild(foot);
    }
    // State renders change the popover's height (compose → loading → result) —
    // re-anchor so it stays inside the field.
    if (!waPop.hidden) waPositionPop();
  }

  function waEnhance() {
    if (!waActiveEl) return;
    const el = waActiveEl;
    const reqId = ++waReqId;
    waView.mode = 'loading';
    waRender();
    const payload = {
      type: 'ENHANCE_TEXT',
      text: waGetText(el),
      instruction: waView.instruction || '',
      field: waFieldInfo(el),
      page: { url: location.href, title: document.title },
    };
    let p;
    try {
      p = chrome.runtime.sendMessage(payload);
    } catch {
      waView.mode = 'error';
      waView.error = 'Extension unavailable \u2014 try reloading the page.';
      waRender();
      return;
    }
    Promise.resolve(p).then((resp) => {
      if (reqId !== waReqId || waActiveEl !== el) return; // stale / superseded
      if (resp && resp.ok) {
        waView.mode = 'result';
        waView.result = String(resp.text || '');
      } else {
        waView.mode = 'error';
        waView.error = (resp && resp.error) || 'Enhance failed.';
      }
      waRender();
    }).catch(() => {
      if (reqId !== waReqId) return;
      waView.mode = 'error';
      waView.error = 'Extension unavailable \u2014 try reloading the page.';
      waRender();
    });
  }

  /** Framework-safe write-back. Textareas: use the element's own native value
   *  setter (so React's value tracker sees the change), then fire input +
   *  change. Contenteditable editors (CodeMirror/ProseMirror/Lexical): go
   *  through the editor's own input pipeline (select-all + execCommand
   *  insertText/insertLineBreak) so its internal state stays in sync — a
   *  direct textContent write would be clobbered by the next editor update. */
  function setEnhancedValue(el, text) {
    el.focus();
    if (el.isContentEditable) {
      if (waInsertEditableText(el, text)) return;
      el.textContent = text; // fallback (no execCommand: old engines/tests)
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    let setter = null;
    let proto = Object.getPrototypeOf(el);
    while (proto && !setter) {
      const d = Object.getOwnPropertyDescriptor(proto, 'value');
      if (d && typeof d.set === 'function') setter = d.set;
      else proto = Object.getPrototypeOf(proto);
    }
    if (setter) setter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /** Select-all + insert via execCommand, one insertText per line with
   *  insertLineBreak between (execCommand('insertText') mangles '\n' in some
   *  editors). Returns false when unsupported — caller falls back. */
  function waInsertEditableText(el, text) {
    try {
      if (typeof document.execCommand !== 'function') return false;
      const sel = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      const lines = String(text).split('\n');
      let ok = document.execCommand('insertText', false, lines[0]);
      for (let i = 1; ok && i < lines.length; i++) {
        ok = document.execCommand('insertLineBreak') &&
          document.execCommand('insertText', false, lines[i]);
      }
      return ok;
    } catch {
      return false;
    }
  }

  function waAccept() {
    if (!waActiveEl || !waView.result) return;
    setEnhancedValue(waActiveEl, waView.result);
    waClose();
  }

  function waOnFocusIn(e) {
    if (!waEnabled) return;
    if (waHideTimer) { clearTimeout(waHideTimer); waHideTimer = null; }
    const t = e.target;
    if (!waEligible(t)) return;
    waBuild();
    if (waPop && !waPop.hidden && waActiveEl !== t) waClose();
    waActiveEl = t;
    waShowIcon();
  }

  function waOnFocusOut() {
    if (!waReady) return;
    if (waPop && !waPop.hidden) return; // keep UI while the popover is open
    if (waHideTimer) clearTimeout(waHideTimer);
    waHideTimer = setTimeout(() => {
      waHideTimer = null;
      if (!waEligible(document.activeElement)) waHideIcon();
    }, WA_GRACE_MS);
  }

  function waLoadSetting() {
    try {
      chrome.storage.sync.get({ enableWriteAssist: true }, (res) => {
        waEnabled = !(res && res.enableWriteAssist === false);
        if (!waEnabled) { waHideIcon(); if (waPop) waPop.hidden = true; }
      });
      chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.enableWriteAssist) {
          waEnabled = changes.enableWriteAssist.newValue !== false;
          if (!waEnabled) { waHideIcon(); if (waPop) waPop.hidden = true; }
        }
      });
    } catch { /* storage unavailable */ }
  }

  function initWriteAssist() {
    if (!waAvailable()) return;
    waLoadSetting();
    document.addEventListener('focusin', waOnFocusIn, true);
    document.addEventListener('focusout', waOnFocusOut, true);
    window.addEventListener('scroll', () => {
      if (waActiveEl && waReady) { waShowIcon(); if (waPop && !waPop.hidden) waPositionPop(); }
    }, true);
    window.addEventListener('resize', () => {
      if (waActiveEl && waReady) { waShowIcon(); if (waPop && !waPop.hidden) waPositionPop(); }
    });
    document.addEventListener('mousedown', (e) => {
      if (!waPop || waPop.hidden) return;
      const path = typeof e.composedPath === 'function' ? e.composedPath() : [];
      if (!path.includes(waPop) && !path.includes(waIcon)) waClose();
    }, true);
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && waPop && !waPop.hidden) waClose();
    }, true);
  }

  initWriteAssist();

  // Listen for messages from background/service worker
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    switch (request.type) {
      case 'CAPTURE_CONTEXT':
        sendResponse(isAlive() ? captureContext(request.tier, { pull: request.pull }) : { error: 'Extension context unavailable' });
        break;
      case 'EXECUTE_ACTION':
        if (request.actions && Array.isArray(request.actions)) {
          Promise.all(request.actions.map(executeAction))
            .then((results) => sendResponse({ ok: true, results }))
            .catch((err) => sendResponse({ ok: false, error: err.message }));
          return true; // async
        }
        executeAction(request.action)
          .then(sendResponse)
          .catch((err) => sendResponse({ ok: false, error: err.message }));
        return true; // async
      default:
        // Unknown request type — respond cleanly so the caller's
        // sendMessage promise doesn't reject with "message port closed".
        sendResponse({ ok: false, error: `Unknown request type: ${request.type}` });
        break;
    }
  });
})();
