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

// String fields per step type that may carry {{param}} references.
const PARAM_FIELDS = {
  navigate: ['url'],
  fill: ['value'],
  attach: ['path'],
  human: ['instructions'],
  done: ['message'],
};

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
  // Evidence keys declared by extract steps — valid substitution refs alongside
  // params ({{registration}} in a done message, per the #220 worked example).
  const evidenceKeys = new Set(
    steps ? steps.filter((s) => s?.type === 'extract').map((s) => s.evidenceKey).filter(Boolean) : [],
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
          if (validateCues(step, i, errors) && typeof step.value !== 'string') {
            errors.push(`Step ${n} (fill): value must be a string`);
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
        const text = step[field];
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
      if (typeof step[field] === 'string') {
        step[field] = step[field].replace(PARAM_REF_RE, (_, name) => effective[name] ?? '');
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
