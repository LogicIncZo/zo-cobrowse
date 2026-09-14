// Recipes (#220) — repeatable multi-page workflows as a first-class primitive.
// Pure half: validation (incl. the submitish-requires-human invariant),
// parameter substitution, version bumping, run progress lines. No chrome.*
// or DOM dependencies — imported by background.js and directly by tests.
// Contract: tests/schemas/recipes.ts. Design: docs/superpowers/specs/2026-09-14-recipes-design.md

export const RECIPE_STEP_TYPES = [
  'navigate', 'fill', 'click', 'check', 'attach', 'extract', 'waitFor', 'human', 'done',
];

// Interactive step types that must carry a non-empty cue array.
const CUED_STEP_TYPES = new Set(['fill', 'click', 'check', 'attach', 'extract']);

export const CUE_STRATEGIES = ['selector', 'text', 'label', 'aria', 'placeholder', 'question'];

export const MAX_WAIT_MS = 15000;

const VERSION_RE = /^\d+\.\d+\.\d+$/;
const PARAM_REF_RE = /\{\{\s*([A-Za-z0-9_-]+)\s*\}\}/g;

// String fields per step type that may carry {{param}} references. Dotted
// paths reach into sub-objects (generate.prompt).
const PARAM_FIELDS = {
  navigate: ['url'],
  fill: ['value', 'generate.prompt', 'generate.contextFile'],
  attach: ['path'],
  human: ['instructions'],
  done: ['message'],
};

function fieldAt(step, dotted) {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), step);
}

function setFieldAt(step, dotted, val) {
  const parts = dotted.split('.');
  const last = parts.pop();
  const host = parts.reduce((o, k) => o[k], step);
  host[last] = val;
}

function isHttpUrl(url) {
  return typeof url === 'string' && /^https?:\/\//.test(url);
}

function validCue(c) {
  return !!c && typeof c === 'object'
    && CUE_STRATEGIES.includes(c.strategy)
    && typeof c.value === 'string' && c.value.length > 0;
}

function validateCues(step, i, errors) {
  if (!Array.isArray(step.cues) || step.cues.length === 0) {
    errors.push(`Step ${i + 1} (${step.type}): non-empty cues array required`);
    return false;
  }
  if (!step.cues.every(validCue)) {
    errors.push(`Step ${i + 1} (${step.type}): every cue needs a strategy (${CUE_STRATEGIES.join('|')}) and a value`);
    return false;
  }
  return true;
}

// The load-bearing guarantee (#220): a submitish click may only execute as the
// step IMMEDIATELY following a human checkpoint — the human has just been on
// the page and clicked through by hand. Everything else is a validation error,
// so an undeclared submit can never be saved, loaded, or replayed.
function checkSubmitInvariant(steps, errors) {
  steps.forEach((step, i) => {
    if (step.type === 'click' && step.submitish === true) {
      const prev = i > 0 ? steps[i - 1] : null;
      if (!prev || prev.type !== 'human') {
        errors.push(`Step ${i + 1} (click): submitish click must immediately follow a human step — declare the checkpoint before it`);
      }
    }
  });
}

export function validateRecipe(recipe) {
  const errors = [];
  const warnings = [];

  if (!recipe || typeof recipe !== 'object') {
    return { ok: false, errors: ['Recipe must be an object'], warnings };
  }
  if (typeof recipe.id !== 'string' || !recipe.id) errors.push('id is required');
  if (typeof recipe.name !== 'string' || !recipe.name) errors.push('name is required');
  if (typeof recipe.version !== 'string' || !VERSION_RE.test(recipe.version)) {
    errors.push('version must be MAJOR.MINOR.PATCH');
  }
  if (typeof recipe.origin !== 'string' || !recipe.origin) errors.push('origin is required');

  // Params
  const paramNames = new Set();
  if (!Array.isArray(recipe.params)) {
    errors.push('params must be an array');
  } else {
    recipe.params.forEach((p) => {
      if (!p || typeof p.name !== 'string' || !p.name) {
        errors.push('every param needs a name');
      } else if (paramNames.has(p.name)) {
        errors.push(`Duplicate param: ${p.name}`);
      } else {
        paramNames.add(p.name);
      }
      if (!p || !['string', 'number', 'url'].includes(p.type)) {
        errors.push(`Param ${p?.name ?? '?'}: type must be string|number|url`);
      }
      if (p?.required && (!p.question || typeof p.question !== 'string')) {
        errors.push(`Param ${p?.name ?? '?'}: required params need a question for the params card`);
      }
    });
  }

  // Steps
  const steps = Array.isArray(recipe.steps) ? recipe.steps : null;
  // Evidence keys declared by extract steps AND generate fills — valid
  // substitution refs alongside params ({{registration}} per the #220 worked
  // example; {{application_text}} per #228).
  const evidenceKeys = new Set(
    steps
      ? steps
          .filter((s) => (s?.type === 'extract' || s?.type === 'fill') && s.evidenceKey)
          .map((s) => s.evidenceKey)
      : [],
  );
  if (!steps || steps.length === 0) {
    errors.push('steps must be a non-empty array');
  } else {
    steps.forEach((step, i) => {
      if (!step || typeof step !== 'object' || !RECIPE_STEP_TYPES.includes(step.type)) {
        errors.push(`Step ${i + 1}: Unknown step type`);
        return;
      }
      const n = i + 1;
      switch (step.type) {
        case 'navigate': {
          if (!isHttpUrl(step.url)) errors.push(`Step ${n} (navigate): http(s) url required`);
          if (step.expectUrl !== undefined && (typeof step.expectUrl !== 'string' || !step.expectUrl)) {
            errors.push(`Step ${n} (navigate): expectUrl must be a non-empty string`);
          } else if (step.expectUrl === undefined) {
            warnings.push(`Step ${n} (navigate): no expectUrl precondition — add one so a mis-navigation parks instead of cascading`);
          }
          break;
        }
        case 'fill':
          if (validateCues(step, i, errors)) {
            const hasValue = typeof step.value === 'string';
            const hasGenerate = step.generate != null;
            if (hasGenerate) {
              const g = step.generate;
              if (typeof g !== 'object' || typeof g.prompt !== 'string' || !g.prompt.trim()) {
                errors.push(`Step ${n} (fill): generate needs a prompt`);
              }
              if (g.maxChars !== undefined && (typeof g.maxChars !== 'number' || g.maxChars <= 0)) {
                errors.push(`Step ${n} (fill): generate maxChars must be a positive number`);
              }
              if (g.contextFile !== undefined && (typeof g.contextFile !== 'string' || !g.contextFile.trim())) {
                errors.push(`Step ${n} (fill): generate contextFile must be a non-empty string`);
              }
              if (g.review !== undefined && typeof g.review !== 'boolean') {
                errors.push(`Step ${n} (fill): generate review must be a boolean`);
              }
              if (hasValue) errors.push(`Step ${n} (fill): use either value or generate, not both`);
              if (step.evidenceKey !== undefined && typeof step.evidenceKey !== 'string') {
                errors.push(`Step ${n} (fill): evidenceKey must be a string`);
              }
              if (step.label !== undefined && typeof step.label !== 'string') {
                errors.push(`Step ${n} (fill): label must be a string`);
              }
            } else if (!hasValue) {
              errors.push(`Step ${n} (fill): either value or generate is required`);
            }
          }
          break;
        case 'click':
          validateCues(step, i, errors);
          if (step.submitish !== undefined && typeof step.submitish !== 'boolean') {
            errors.push(`Step ${n} (click): submitish must be a boolean`);
          }
          break;
        case 'check':
          validateCues(step, i, errors);
          if (step.checked !== undefined && typeof step.checked !== 'boolean') {
            errors.push(`Step ${n} (check): checked must be a boolean`);
          }
          break;
        case 'attach':
          if (validateCues(step, i, errors) && (typeof step.path !== 'string' || !step.path)) {
            errors.push(`Step ${n} (attach): workspace path required`);
          }
          break;
        case 'extract':
          if (validateCues(step, i, errors)) {
            if (typeof step.evidenceKey !== 'string' || !step.evidenceKey) errors.push(`Step ${n} (extract): evidenceKey required`);
            if (typeof step.label !== 'string' || !step.label) errors.push(`Step ${n} (extract): label required`);
          }
          break;
        case 'waitFor': {
          const hasCondition = validCue(step.cue) || (typeof step.url === 'string' && step.url);
          if (!hasCondition) errors.push(`Step ${n} (waitFor): a cue or url condition is required`);
          if (step.timeoutMs !== undefined && (typeof step.timeoutMs !== 'number' || step.timeoutMs <= 0 || step.timeoutMs > MAX_WAIT_MS)) {
            errors.push(`Step ${n} (waitFor): timeoutMs must be 1..${MAX_WAIT_MS}`);
          }
          break;
        }
        case 'human': {
          if (typeof step.title !== 'string' || !step.title) errors.push(`Step ${n} (human): title required`);
          if (typeof step.instructions !== 'string' || !step.instructions) errors.push(`Step ${n} (human): instructions required`);
          const r = step.resumeOn;
          const hasPost = !!r && typeof r === 'object'
            && ((typeof r.url === 'string' && r.url) || validCue(r.cue));
          if (!hasPost) errors.push(`Step ${n} (human): resumeOn needs a url or cue postcondition`);
          if (step.timeoutMinutes !== undefined && (typeof step.timeoutMinutes !== 'number' || step.timeoutMinutes <= 0)) {
            errors.push(`Step ${n} (human): timeoutMinutes must be a positive number`);
          }
          break;
        }
        case 'done':
          break;
      }
      // Cue-multiplicity guidance: a lone selector cue is brittle.
      if (CUED_STEP_TYPES.has(step.type) && Array.isArray(step.cues) && step.cues.length === 1 && step.cues[0].strategy === 'selector') {
        warnings.push(`Step ${n} (${step.type}): single selector cue is brittle — add a text/label/question cue as fallback`);
      }
      // Unknown {{param}} references ({{evidenceKey}} refs are also legal)
      for (const field of PARAM_FIELDS[step.type] || []) {
        const text = fieldAt(step, field);
        if (typeof text === 'string') {
          for (const m of text.matchAll(PARAM_REF_RE)) {
            if (!paramNames.has(m[1]) && !evidenceKeys.has(m[1])) {
              errors.push(`Step ${n} (${step.type}): Unknown parameter: ${m[1]}`);
            }
          }
        }
      }
    });
    checkSubmitInvariant(steps, errors);
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function substituteParams(recipe, values) {
  const errors = [];
  const declared = Array.isArray(recipe?.params) ? recipe.params : [];
  const vals = values && typeof values === 'object' ? values : {};

  for (const p of declared) {
    if (vals[p.name] === undefined && p.default === undefined && p.required) {
      errors.push(`Missing required param: ${p.name}`);
    }
  }
  const declaredNames = new Set(declared.map((p) => p.name));
  for (const key of Object.keys(vals)) {
    if (!declaredNames.has(key)) errors.push(`Unknown param value: ${key}`);
  }
  if (errors.length) return { ok: false, errors, recipe };

  const effective = {};
  for (const p of declared) effective[p.name] = vals[p.name] !== undefined ? String(vals[p.name]) : String(p.default);

  const out = JSON.parse(JSON.stringify(recipe));
  for (const step of out.steps) {
    for (const field of PARAM_FIELDS[step.type] || []) {
      const text = fieldAt(step, field);
      if (typeof text === 'string') {
        // Only rewrite DECLARED params — {{evidenceKey}} refs (validateRecipe
        // accepts them) must survive for the player's interpolation.
        setFieldAt(step, field, text.replace(PARAM_REF_RE, (m, name) => (name in effective ? effective[name] : m)));
      }
    }
  }
  return { ok: true, errors: [], recipe: out };
}

export function bumpVersion(version, kind = 'patch') {
  if (typeof version !== 'string' || !VERSION_RE.test(version)) return null;
  const [maj, min, pat] = version.split('.').map(Number);
  if (kind === 'major') return `${maj + 1}.0.0`;
  if (kind === 'minor') return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

// One-line status for the panel's recipe progress chip. `run` is the
// RecipeRun (tests/schemas/recipes.ts); `now` is injectable for tests.
export function recipeProgress(run, now = Date.now()) {
  const mins = Math.max(0, Math.floor((now - run.startedAt) / 60000));
  const evidence = `${run.evidence.length} evidence`;
  const terminal = ['done', 'aborted', 'blocked', 'paused'];
  if (terminal.includes(run.status)) {
    const reason = run.status === 'blocked' && run.stopReason ? ` — ${run.stopReason}` : '';
    return `${run.status}${reason} · ${evidence} · ${mins}m`;
  }
  const step = `step ${run.stepIndex + 1}/${run.stepsTotal}`;
  if (run.status === 'waiting_human') {
    return `waiting for you — ${run.humanTitle || 'checkpoint'} · ${step} · ${evidence} · ${mins}m`;
  }
  return `${run.status} · ${step} · ${evidence} · ${mins}m`;
}

// ---- Healer pure halves (#220) --------------------------------------------

// The cue-miss re-ground prompt: one-shot (generateMode pattern — no
// conversation_id), JSON-only reply. NOTE: pageContext fields must be
// REDACTED by the caller before building this — the prompt builder also
// strips live field values defensively (values never leave the extension).
export function healPrompt(recipe, step, miss, pageContext) {
  const ctx = pageContext || {};
  const fields = (Array.isArray(ctx.formFields) ? ctx.formFields : [])
    .map((f) => `${f.tag || 'input'}${f.type ? `[${f.type}]` : ''} "${String(f.question || f.placeholder || f.name || '').slice(0, 80)}" ${f.selector || ''}`)
    .join('; ');
  const candidates = (Array.isArray(miss?.candidates) ? miss.candidates : [])
    .map((c) => `- ${String(c.text || '').slice(0, 60)} (${c.selector || 'no selector'})`);
  return [
    '## Recipe Step Repair',
    '',
    `Recipe "${recipe?.name || 'unnamed'}" is playing deterministically and its cues matched nothing.`,
    `Failing step (${step?.type}): tried cues, in order — ${Array.isArray(miss?.tried) ? miss.tried.join('; ') : 'none recorded'}`,
    candidates.length ? `Near-miss candidates the page DID offer:\n${candidates.join('\n')}` : 'No near-miss candidates were captured.',
    '',
    'Current page:',
    `- URL: ${ctx.url || 'unknown'}`,
    `- Title: ${ctx.title || 'unknown'}`,
    fields ? `- Form fields: ${fields}` : '- No form fields captured.',
    '',
    'Respond with ONLY a JSON object, no prose:',
    '{"cues": [{"strategy": "…", "value": "…"}], "note": "one-line reason"}',
    'Replace the step\'s cue array, best strategy first. Strategies: selector | text | label | aria | placeholder | question. Use AT LEAST TWO cues and never a single selector alone.',
  ].join('\n');
}

// Parse the healer's reply: fenced or bare JSON, cues shape-checked here
// (strategy known, values non-empty, ≥2 cues so an answer is never a lone
// selector). Returns {ok, cues, note} | {ok:false, error}.
export function parseRecipeHealResponse(text) {
  const fenced = typeof text === 'string' ? text : '';
  const jsonSlice = fenced.indexOf('{');
  if (jsonSlice === -1) return { ok: false, error: 'healer reply contained no JSON' };
  const end = fenced.lastIndexOf('}');
  if (end <= jsonSlice) return { ok: false, error: 'healer reply contained no JSON object' };
  let parsed;
  try {
    parsed = JSON.parse(fenced.slice(jsonSlice, end + 1));
  } catch (e) {
    return { ok: false, error: `healer reply was not valid JSON: ${e.message}` };
  }
  const cues = Array.isArray(parsed?.cues) ? parsed.cues : null;
  if (!cues || cues.length === 0) return { ok: false, error: 'healer reply had no cues' };
  const valid = cues.every((c) => c
    && typeof c.value === 'string' && c.value.trim()
    && CUE_STRATEGIES.includes(c.strategy));
  if (!valid) return { ok: false, error: 'healer cues must each carry a known strategy and a value' };
  if (cues.length < 2) return { ok: false, error: 'healer must answer with at least two cues (never a single selector)' };
  return { ok: true, cues, note: typeof parsed.note === 'string' ? parsed.note : undefined };
}

// ---- Recorder pure halves (#220) -------------------------------------------
// A recording session buffers observation records ({op, url, title, cues,
// value?, pageSensitive, submitish?, ts}) — the content recorder snapshots
// cue metadata per event and NEVER emits sensitive field values. Assembly
// turns the buffer into a draft Recipe deterministically; the LLM cleanup
// pass only renames params / inserts checkpoints / tidies cues.

const SENSITIVE_PAGE_URL_RE = /login|signin|sign-in|signup|sign-up|register|checkout|payment|billing|password|banking/i;

// Background-side re-check: a page is sensitive if the recorder flagged it OR
// the URL pattern matches — the collapse must not depend on one signal.
export function isSensitivePageEvent(ev) {
  if (!ev) return false;
  if (ev.pageSensitive === true) return true;
  return typeof ev.url === 'string' && SENSITIVE_PAGE_URL_RE.test(ev.url);
}

function slugParam(text) {
  const slug = String(text || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
  return slug || 'value';
}

function cueText(cues) {
  const hit = (Array.isArray(cues) ? cues : []).find((c) => c && c.strategy !== 'selector' && typeof c.value === 'string' && c.value.trim());
  return hit ? hit.value.trim() : '';
}

function cleanCues(cues) {
  return (Array.isArray(cues) ? cues : []).filter((c) => c
    && typeof c.value === 'string' && c.value.trim()
    && CUE_STRATEGIES.includes(c.strategy));
}

function safeExpectUrl(url) {
  try { return new URL(url).pathname + new URL(url).search; } catch { return url; }
}

function safeHost(url) {
  try { return new URL(url).host || 'the page'; } catch { return 'the page'; }
}

// Ordered observation buffer → draft Recipe. Sensitive-page event runs
// collapse into ONE human checkpoint (resumeOn = the first clean page after
// them — or an unmatchable sentinel, forcing the "Skip check" fallback);
// clean-page submitish clicks get a human step inserted before them so the
// draft always passes validateRecipe's E-INVARIANT; fill values become param
// defaults (kept locally); attach paths become required params.
export function assembleDraftRecipe(obs, name, now = Date.now()) {
  const events = Array.isArray(obs) ? obs.filter(Boolean) : [];
  if (!events.length) return { ok: false, errors: ['no recorded events'], recipe: null };

  const params = [];
  const steps = [];
  const usedNames = new Set();
  const addParam = (question, defaultValue, nameBase) => {
    const base = slugParam(nameBase || question);
    let n = base;
    let k = 2;
    while (usedNames.has(n)) n = `${base}_${k++}`;
    usedNames.add(n);
    const param = { name: n, type: 'string', required: defaultValue === undefined || defaultValue === '', question: question || n };
    if (defaultValue !== undefined && defaultValue !== '') param.default = defaultValue;
    params.push(param);
    return `{{${n}}}`;
  };

  let i = 0;
  while (i < events.length) {
    const ev = events[i];
    if (ev.op === 'navigate') {
      steps.push({ type: 'navigate', url: ev.url, expectUrl: safeExpectUrl(ev.url) });
      i += 1;
      continue;
    }
    if (isSensitivePageEvent(ev)) {
      // Collapse the whole sensitive run — the user did it by hand once and
      // will do it by hand on every replay.
      let j = i;
      while (j < events.length && isSensitivePageEvent(events[j])) j += 1;
      const after = events[j];
      const resumeUrl = after ? safeExpectUrl(after.url) : 'RECIPE-AWAITING-MANUAL-STEP';
      steps.push({
        type: 'human',
        title: `Complete ${safeHost(ev.url)} by hand`,
        instructions: after
          ? 'This part of the flow touches sensitive pages the recipe must not automate — payment, OTP, credentials. You did it manually during recording; do it manually on replay, then continue.'
          : 'This part of the flow touches sensitive pages the recipe must not automate. Finish it, then use "Skip check" to complete the recipe.',
        resumeOn: { url: resumeUrl },
      });
      i = j;
      continue;
    }
    const cues = cleanCues(ev.cues);
    switch (ev.op) {
      case 'fill': {
        if (!cues.length) break; // unidentifiable field — drop rather than misfire
        const question = cueText(cues) || 'Field';
        const ref = addParam(question, typeof ev.value === 'string' ? ev.value : undefined);
        steps.push({ type: 'fill', cues, value: ref });
        break;
      }
      case 'check':
        if (cues.length) steps.push({ type: 'check', cues });
        break;
      case 'click': {
        if (!cues.length) break;
        if (ev.submitish === true) {
          // The invariant, authored: the draft cannot auto-click submit.
          steps.push({
            type: 'human',
            title: 'Review, then submit',
            instructions: 'The recipe never clicks a submit button for you — review the page, make the final click yourself, then continue.',
            resumeOn: { url: safeExpectUrl(ev.url) },
          });
        }
        steps.push({ type: 'click', cues, ...(ev.submitish === true ? { submitish: true } : {}) });
        break;
      }
      case 'attach': {
        if (!cues.length) break;
        const ref = addParam(`Workspace path of ${ev.fileName || 'the attached file'}`, undefined, ev.fileName);
        steps.push({ type: 'attach', cues, path: ref });
        break;
      }
    }
    i += 1;
  }

  if (!steps.length) return { ok: false, errors: ['no usable recorded events'], recipe: null };
  steps.push({ type: 'done', message: 'Recorded recipe complete' });
  return {
    ok: true,
    errors: [],
    recipe: {
      id: `rcp-${slugParam(name) || 'draft'}-${Math.random().toString(36).slice(2, 6)}`,
      name: String(name || 'Recorded recipe'),
      version: '1.0.0',
      origin: 'recorded',
      draft: true,
      createdAt: now,
      updatedAt: now,
      params,
      steps,
    },
  };
}

// The LLM cleanup prompt for a recorded draft: rename params, insert human
// checkpoints, tidy cues. Param DEFAULTS are stripped — recorded values stay
// local and never reach the model.
export function generateRecipePrompt(draft) {
  const slim = {
    name: draft?.name || 'Recorded recipe',
    params: (Array.isArray(draft?.params) ? draft.params : []).map((p) => {
      const { default: _omit, ...rest } = p;
      return rest;
    }),
    steps: draft?.steps || [],
  };
  return [
    '## Recipe Draft',
    '',
    'The user recorded this multi-page flow manually. Clean it into a replayable recipe:',
    '- Give each {{param}} a clear question for the run-start prompt; keep {{...}} references consistent.',
    '- Insert human checkpoints before anything trust-critical (payment, OTP, captcha). A click step with "submitish": true is ONLY legal immediately after a human step — keep that true.',
    '- Improve cues: label/question/aria strategies beat bare selectors; keep AT LEAST TWO cues per interactive step.',
    '- Keep the flow linear (no branching or looping).',
    '',
    'Respond with ONLY a JSON object:',
    '{"params": [{"name":"…","type":"string","required":true,"question":"…","default":"…"}], "steps": [ …same step shapes… ], "note": "one line"}',
    '',
    'Current draft (param defaults redacted):',
    '```json',
    JSON.stringify(slim, null, 2),
    '```',
  ].join('\n');
}

// Parse the cleanup reply. Shape-check only — the caller runs validateRecipe
// (which enforces the invariant) before anything is saved.
export function parseGeneratedRecipe(text) {  const raw = typeof text === 'string' ? text : '';
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return { ok: false, error: 'reply contained no JSON object' };
  let parsed;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch (e) {
    return { ok: false, error: `reply was not valid JSON: ${e.message}` };
  }
  if (!Array.isArray(parsed?.steps) || !parsed.steps.length) {
    return { ok: false, error: 'reply had no steps' };
  }
  return {
    ok: true,
    recipe: { params: Array.isArray(parsed.params) ? parsed.params : [], steps: parsed.steps },
    note: typeof parsed.note === 'string' ? parsed.note : undefined,
  };
}

// ---- Generate-at-runtime fill values (#228) --------------------------------

// The one-shot field-drafting prompt for a fill step with a `generate` block.
// `step.generate.prompt` (and contextFile content, fetched by the caller) is
// already param-substituted at run start. Plain-text reply protocol — no JSON,
// no quotes, no commentary: the reply IS the field value.
export function generateValuePrompt(step) {
  const g = step.generate || {};
  const lines = [
    '## Recipe Field Draft',
    '',
    'You are drafting the value for ONE form field while a saved recipe replays.',
    '',
    g.prompt || '',
    '',
  ];
  if (g.maxChars) {
    lines.push(`Hard limit: at most ${g.maxChars} characters — the form field will reject more. Stay under it.`);
  }
  lines.push(
    'Respond with only the field text itself — no quotes, no explanation, no markdown fences.',
  );
  return lines.join('\n');
}
