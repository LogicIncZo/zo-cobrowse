// Zo utility prompts — the one-shot prompt builders for background's
// non-chat Zo calls (generateMode, runSkill, createAutomation, listAutomations,
// testConnection). Extracted verbatim from inline background.js strings so the
// prompt-evals harness (scripts/prompt-evals) can eval the EXACT prompts the
// extension sends — single source of truth, no duplicated copies drifting.
// Pure logic, no chrome.* dependencies. Mode prompts live in prompt.js/
// modes.js; the write-assist prompt in write-assist.js.

/** generateMode (#✎ Mode generator): reply is strict JSON with 7 Mode fields. */
export function buildGenerateModePrompt(description) {
  return `You are a Mode designer for a browser co-browsing AI assistant. Based on this user description, generate a custom Mode.

User description: ${description}

Create a Mode with these fields:
1. name: A short, catchy name (2-4 words)
2. description: One sentence explaining what this Mode does
3. icon: A single emoji
4. systemPrompt: A paragraph setting the AI's role and behavior for this task (write as if addressing the AI directly, starting with "You are Zo —")
5. instructions: Detailed instructions for how the AI should respond, including output format guidance.
6. contextTier: 0 (URL only), 1 (+page text), 2 (+clickable elements & form fields), or 3 (+screenshot)
7. expectJson: true if the mode should drive browser actions, false if it should reply with plain markdown

Return ONLY valid JSON with those 7 fields. No markdown, no explanation.`;
}

/** runSkill (#04): point Zo at the skill's SKILL.md with page content as input. */
export function buildRunSkillPrompt(skillName, pageContext) {
  return `Run the skill named "${skillName}" using the content from the current page as input.

Page URL: ${pageContext?.url || '(unknown)'}
Page title: ${pageContext?.title || '(unknown)'}

Page text (first 2000 chars):
${(pageContext?.visibleText || '').slice(0, 2000)}

Read the skill's SKILL.md and follow its instructions.`;
}

/** createAutomation (#08): create a scheduled automation via the create_agent tool. */
export function buildCreateAutomationPrompt(instruction, rrule, pageContext) {
  return `Create a scheduled automation with these parameters:
  - Instruction: ${instruction}
  - Schedule (RRULE): ${rrule || 'FREQ=DAILY'}
  - Source page URL: ${pageContext?.url || '(unknown)'}
  - Source page title: ${pageContext?.title || '(unknown)'}

Context from the page (first 1000 chars):
${(pageContext?.visibleText || '').slice(0, 1000)}

Use the create_agent tool to create this automation now.`;
}

/** listAutomations (#08): read-only inventory of the user's automations. */
export function buildListAutomationsPrompt() {
  return 'List all my automations. For each, return the title, schedule (RRULE), and delivery method.';
}

/** testConnection: the smallest possible liveness probe. */
export function buildTestConnectionPrompt() {
  return 'Reply with just: ZO_OK';
}
