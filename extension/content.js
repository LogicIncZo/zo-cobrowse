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
