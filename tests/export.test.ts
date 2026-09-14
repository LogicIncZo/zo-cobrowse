import { describe, it, expect } from "bun:test";
import {
  conversationToMarkdown,
  exportFileName,
  slugifyTitle,
  buildPageExport,
  pageContextToMarkdown,
  pageExportFileName,
} from "../extension/lib/export.js";
import {
  ExportRequest,
  MarkdownExport,
  ExportFileName,
  ExportedMessage,
  PageExport,
  PageMarkdownExport,
  PageExportFileName,
} from "./schemas/export";

const NOW = 1788048000000; // 2026-08-30 UTC — fixed clock

const conv = {
  title: "Compare the 5 product tabs",
  exportedAt: NOW,
  messages: [
    { role: "system", text: "Connected to Zo." },
    { role: "user", text: "Compare these products", timestamp: NOW },
    {
      role: "assistant",
      text: "Here is the comparison table.",
      reasoning: "I read all five pages and extracted prices.",
      timestamp: NOW + 4200,
      durationMs: 4230,
      contextTier: 2,
      contextReason: "action first turn",
    },
    { role: "error", text: "Response interrupted" },
  ],
};

describe("export — conversationToMarkdown", () => {
  it("renders title header, role turns, tier chip, duration, reasoning blockquote", () => {
    const md = conversationToMarkdown(conv);
    expect(md).toContain("# Compare the 5 product tabs");
    expect(md).toContain("Exported from Zo Co-browse");
    expect(md).toContain("## 🧑 You —");
    expect(md).toContain("Compare these products");
    expect(md).toContain("## 🤖 Zo —");
    expect(md).toContain("🧩 Elements context");
    expect(md).toContain("4.2s");
    expect(md).toContain("Here is the comparison table.");
    expect(md).toContain("> 💭 I read all five pages");
    // non-transcript rows are omitted entirely
    expect(md).not.toContain("Connected to Zo");
    expect(md).not.toContain("Response interrupted");
  });

  it("output passes the schema; input records validate against ExportedMessage", () => {
    const md = conversationToMarkdown(conv);
    expect(() => MarkdownExport.parse(md)).not.toThrow();
    for (const m of conv.messages) {
      expect(() => ExportedMessage.parse(m)).not.toThrow();
    }
    expect(() => ExportRequest.parse(conv)).not.toThrow();
  });

  it("an empty conversation degrades to an honest placeholder, not a throw", () => {
    const md = conversationToMarkdown({ title: "T", messages: [], exportedAt: NOW });
    expect(md).toContain("no exportable turns");
    expect(() => MarkdownExport.parse(md)).not.toThrow();
  });
});

describe("export — filenames", () => {
  it("slugs titles: lowercase, dashes, capped, trimmed", () => {
    expect(slugifyTitle("Compare the 5 product tabs!")).toBe("compare-the-5-product-tabs");
    expect(slugifyTitle("  --Weird___Title!!--  ")).toBe("weird-title");
    expect(slugifyTitle("").length).toBeGreaterThan(0); // never empty
    expect(slugifyTitle("x".repeat(100)).length).toBe(40);
  });

  it("filenames match zo-chat-<slug>-<YYYYMMDD>.md and pass the schema", () => {
    const name = exportFileName("Compare the 5 product tabs", NOW);
    expect(name).toBe("zo-chat-compare-the-5-product-tabs-20260830.md");
    expect(() => ExportFileName.parse(name)).not.toThrow();
    expect(() => ExportFileName.parse(exportFileName("", NOW))).not.toThrow();
  });
});

describe("export — page export (#51)", () => {
  const pageContext = {
    url: "https://example.test/rti-guide",
    title: "How to file an RTI",
    visibleText: "Step 1: identify the department.\nStep 2: draft the question.",
  };

  it("buildPageExport returns the structured note (schema-valid)", () => {
    const exp = buildPageExport(pageContext, NOW);
    expect(exp.title).toBe("How to file an RTI");
    expect(exp.url).toBe("https://example.test/rti-guide");
    expect(exp.body).toContain("Step 1");
    expect(() => PageExport.parse(exp)).not.toThrow();
  });

  it("degrades honestly on empty/missing context", () => {
    const exp = buildPageExport(null, NOW);
    expect(exp.title).toBe("Untitled page");
    expect(exp.body).toBe("");
    expect(() => PageExport.parse(exp)).not.toThrow();
    const md = pageContextToMarkdown(null, NOW);
    expect(md).toContain("No readable content");
    expect(() => PageMarkdownExport.parse(md)).not.toThrow();
  });

  it("pageContextToMarkdown renders title, source attribution, saved day, body", () => {
    const md = pageContextToMarkdown(pageContext, NOW);
    expect(md.startsWith("# How to file an RTI")).toBe(true);
    expect(md).toContain("> **Source:** https://example.test/rti-guide");
    expect(md).toContain("> **Saved:**");
    expect(md).toContain("Step 2: draft the question.");
    expect(() => PageMarkdownExport.parse(md)).not.toThrow();
  });

  it("page filenames match zo-page-<slug>-<YYYYMMDD>.md (distinct from chats)", () => {
    const name = pageExportFileName("How to file an RTI", NOW);
    expect(name).toBe("zo-page-how-to-file-an-rti-20260830.md");
    expect(() => PageExportFileName.parse(name)).not.toThrow();
    expect(name.startsWith("zo-chat-")).toBe(false);
  });
});
