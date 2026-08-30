import { describe, it, expect } from "bun:test";
import { readFileSync } from "fs";
import { resolve } from "path";

const EXT = resolve(import.meta.dir, "../extension");
const css = readFileSync(resolve(EXT, "styles.css"), "utf-8");

/**
 * Assert that a CSS selector's rule block contains a given declaration.
 * Matches the selector (with its brace-delimited block) anywhere in the file.
 */
function ruleBlock(selector: string): string {
  const idx = css.indexOf(selector);
  if (idx === -1) throw new Error(`selector not found: ${selector}`);
  const braceStart = css.indexOf("{", idx);
  const braceEnd = css.indexOf("}", braceStart);
  if (braceStart === -1 || braceEnd === -1) {
    throw new Error(`could not isolate rule block for: ${selector}`);
  }
  return css.slice(braceStart, braceEnd);
}

describe("sticky top region layout", () => {
  it("the shell is a flex column that owns the full viewport height", () => {
    const block = ruleBlock(".shell");
    expect(block).toContain("display: flex");
    expect(block).toContain("flex-direction: column");
    expect(block).toContain("height: 100%");
  });

  it("top-region bars do not shrink (they stay pinned above the scroller)", () => {
    // .page-bar is gone (#63): the page title folded into .header-page.
    for (const sel of [".header", ".controls-bar", ".chips-wrap"]) {
      const block = ruleBlock(sel);
      expect(block).toContain("flex-shrink: 0");
    }
  });

  it("#63: the page title lives in the header and ellipsizes, never pushes the actions out", () => {
    const block = ruleBlock(".header-page");
    expect(block).toContain("flex: 1");
    expect(block).toContain("min-width: 0");
    expect(ruleBlock("#page-url")).toContain("text-overflow: ellipsis");
  });

  it("#chat-view fills remaining space and allows its children to scroll (not height:100%)", () => {
    const block = ruleBlock("#chat-view");
    // The fix: flex item that takes the leftover space, with min-height:0 so
    // #messages can scroll instead of growing the shell past the viewport.
    expect(block).toContain("flex: 1");
    expect(block).toContain("min-height: 0");
    // The old buggy rule must not come back — it made #chat-view as tall as
    // the entire shell, causing the whole page to scroll and the top region
    // to scroll out of view.
    expect(block).not.toContain("height: 100%");
  });

  it("#messages is the actual scroll container (overflow-y: auto, flex:1)", () => {
    const block = ruleBlock("#messages");
    expect(block).toContain("overflow-y: auto");
    expect(block).toContain("flex: 1");
  });

  it("the body does not itself scroll (overflow: hidden), so only #messages scrolls", () => {
    // html, body share a rule — find the combined block
    const idx = css.indexOf("html, body");
    const braceStart = css.indexOf("{", idx);
    const braceEnd = css.indexOf("}", braceStart);
    const block = css.slice(braceStart, braceEnd);
    expect(block).toContain("overflow: hidden");
  });
});

describe("Zo-native design system tokens", () => {
  // The conversation surface must stay on Hanken Grotesk + the neutral
  // --zo-* palette to match zo.computer. These guard against regressions
  // back to the old Fraunces/Figtree + amber-only system.
  it("UI + display fonts resolve to Hanken Grotesk (bundled)", () => {
    expect(css).toContain("'Hanken Grotesk'");
    const fontUi = ruleBlock(":root");
    expect(fontUi).toContain("--font-ui: 'Hanken Grotesk'");
    expect(fontUi).toContain("--font-display: 'Hanken Grotesk'");
  });

  it("declares a bundled @font-face (MV3 CSP-safe, no external font-src for text)", () => {
    expect(css).toMatch(/@font-face[^}]*'Hanken Grotesk'/);
    expect(css).toContain("assets/fonts/HankenGrotesk");
  });

  it("defines the Zo-neutral token set in :root", () => {
    const root = ruleBlock(":root");
    for (const tok of [
      "--zo-sidebar", "--zo-foreground", "--zo-primary", "--zo-primary-foreground",
      "--zo-accent", "--zo-accent-foreground", "--zo-muted-foreground",
      "--zo-border", "--zo-border-primary",
    ]) {
      expect(root).toContain(tok);
    }
  });

  it("every theme variant carries the Zo-neutral tokens", () => {
    for (const sel of [
      '[data-theme="dark"]', '[data-theme="light"]', '[data-theme="sepia"]',
      '[data-theme="forest"]', '[data-theme="ocean"]',
    ]) {
      const block = ruleBlock(sel);
      expect(block).toContain("--zo-primary");
      expect(block).toContain("--zo-border");
    }
  });

  it("#messages uses the Zo spacing model (gap-6, pt-8) and a centered rail", () => {
    const block = ruleBlock("#messages");
    expect(block).toContain("gap: 24px");
    expect(block).toContain("padding: 32px");
  });

  it(".msg is capped + centered like Zo's max-w-3xl mx-auto", () => {
    const block = ruleBlock(".msg");
    expect(block).toContain("max-width: 768px");
    expect(block).toContain("margin-inline: auto");
  });
});

describe("Zo-native message bubbles", () => {
  // User = composer-shell (neutral bg + primary-tinted border + shadow,
  // right-aligned). Assistant = bare prose (transparent, no border, 65ch).
  it("user message is a Zo composer-shell (neutral bg + primary border + shadow)", () => {
    const block = ruleBlock(".msg-user .msg-body");
    expect(block).toContain("var(--zo-sidebar)");
    expect(block).toContain("var(--zo-border-primary)");
    expect(block).toContain("box-shadow");
    // alignment lives on the row container, not the body
    expect(ruleBlock(".msg-user")).toContain("justify-content: flex-end");
  });

  it("assistant message is bare prose (transparent, no border, 65ch measure)", () => {
    const block = ruleBlock(".msg-assistant .msg-body");
    expect(block).toContain("background: transparent");
    expect(block).toContain("border: none");
    expect(block).toContain("max-width: 65ch");
    expect(block).toContain("user-select: text");
  });

  it("has the mention-pill style for page/file references", () => {
    const block = ruleBlock(".msg-mention");
    expect(block).toContain("var(--zo-accent)");
    expect(block).toContain("var(--font-code)");
  });
});
