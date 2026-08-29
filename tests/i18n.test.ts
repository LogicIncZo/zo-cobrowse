// i18n scaffolding guard (#68): chrome.i18n with _locales/en/ as default
// locale. UI strings ONLY — prompt templates / action-schema docs stay
// English (they are LLM instructions to Zo, not user-facing text).
import { describe, it, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Window } from "happy-dom";
import { createT, applyI18nDom } from "../extension/lib/i18n.js";
import { ManifestSchema } from "./schemas/manifest";

const ROOT = resolve(import.meta.dir, "..");
const messages = JSON.parse(readFileSync(`${ROOT}/extension/_locales/en/messages.json`, "utf-8"));
const manifest = JSON.parse(readFileSync(`${ROOT}/extension/manifest.json`, "utf-8"));
const sidepanelHtml = readFileSync(`${ROOT}/extension/sidepanel.html`, "utf-8");
const optionsHtml = readFileSync(`${ROOT}/extension/options.html`, "utf-8");

describe("i18n scaffolding (#68)", () => {
  it("manifest uses __MSG_ placeholders + default_locale en, and still validates", () => {
    expect(manifest.default_locale).toBe("en");
    expect(manifest.name).toBe("__MSG_extName__");
    expect(manifest.description).toBe("__MSG_extDescription__");
    expect(ManifestSchema.safeParse(manifest).success).toBe(true);
  });

  it("the localized name/description are IDENTICAL to the pre-i18n strings (no silent copy change)", () => {
    expect(messages.extName.message).toBe("Zo Co-browse");
    expect(messages.extDescription.message).toBe(
      "Co-browsing extension powered by Zo — AI backend that sees your page and takes actions through it.",
    );
  });

  it("every message entry carries a description (translator context from day one)", () => {
    for (const [key, entry] of Object.entries(messages)) {
      expect(typeof entry.message).toBe("string");
      expect(typeof entry.description).toBe("string");
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it("GUARD: every data-i18n* key referenced in extension HTML resolves in en", () => {
    const keys = new Set(Object.keys(messages));
    const missing: string[] = [];
    for (const html of [sidepanelHtml, optionsHtml]) {
      for (const m of html.matchAll(/data-i18n(?:-placeholder|-title|-aria)?="([^"]+)"/g)) {
        if (!keys.has(m[1])) missing.push(m[1]);
      }
    }
    expect(missing).toEqual([]);
  });

  it("createT resolves via the injected getMessage and returns '' for missing keys", () => {
    const t = createT((key: string) => messages[key]?.message);
    expect(t("extName")).toBe("Zo Co-browse");
    expect(t("definitely-not-a-key")).toBe("");
    expect(t("")).toBe("");
    expect(t(undefined as any)).toBe("");
  });

  it("applyI18nDom walks the four attribute flavors (textContent/placeholder/title/aria)", () => {
    const el = (html: string) => {
      const win = new Window();
      win.document.body.innerHTML = html;
      return win.document;
    };
    const doc = el(`
      <button data-i18n="extName"></button>
      <input data-i18n-placeholder="sidepanelComposerPlaceholder" />
      <a data-i18n-title="sidepanelHistory"></a>
      <div data-i18n-aria="sidepanelHelp"></div>
      <span data-i18n="no-such-key"></span>
    `);
    const t = createT((key: string) => messages[key]?.message);
    const applied = applyI18nDom(doc, t);
    expect(applied).toBe(4); // missing keys don't count as applied
    expect(doc.querySelector("button").textContent).toBe("Zo Co-browse");
    expect(doc.querySelector("input").getAttribute("placeholder")).toBe("Ask Zo about this page…");
    expect(doc.querySelector("a").getAttribute("title")).toBe("History");
    expect(doc.querySelector("div").getAttribute("aria-label")).toBe("About co-browsing");
    expect(doc.querySelector("span").textContent).toBe("");
  });
});
