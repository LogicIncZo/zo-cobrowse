import { describe, it, expect } from "bun:test";
import { isSensitiveForm, isSensitiveSubmitProbe, redactValue, reviewRows, fillBatchRows } from "../extension/lib/formfill";
import { SensitivityVerdictSchema, ReviewRowSchema, FillBatchRowSchema } from "./schemas/formfill";

const F = (over: Record<string, unknown> = {}) => ({ type: "text", name: "", placeholder: "", question: "", ...over });

describe("isSensitiveForm", () => {
  it("flags password fields", () => {
    const v = isSensitiveForm([F({ type: "password", name: "pw" })], "https://shop.example/cart");
    expect(SensitivityVerdictSchema.safeParse(v).success).toBe(true);
    expect(v.sensitive).toBe(true);
    expect(v.reasons[0]).toMatch(/password/i);
  });
  it("flags card/cvv/expiry by name or placeholder", () => {
    expect(isSensitiveForm([F({ name: "ccnumber" })], "").sensitive).toBe(true);
    expect(isSensitiveForm([F({ placeholder: "CVV" })], "").sensitive).toBe(true);
    expect(isSensitiveForm([F({ name: "exp-date" })], "").sensitive).toBe(true);
  });
  it("flags sensitive URLs with benign fields", () => {
    const v = isSensitiveForm([F({ name: "email" })], "https://example.com/account/login");
    expect(v.sensitive).toBe(true);
    expect(v.reasons[0]).toMatch(/URL/i);
  });
  it("passes benign forms", () => {
    const v = isSensitiveForm([F({ name: "q" }), F({ name: "email", placeholder: "Your email" })], "https://example.com/search");
    expect(v.sensitive).toBe(false);
    expect(v.reasons).toEqual([]);
  });
  it("tolerates null fields/url", () => {
    expect(isSensitiveForm(null, null).sensitive).toBe(false);
  });
});

describe("redactValue", () => {
  it("masks everything but a 2-char tail (≥4 chars)", () => {
    expect(redactValue("4242424242424242")).toBe("••••42");
  });
  it("fully masks short values and empties", () => {
    expect(redactValue("abc")).toBe("••••");
    expect(redactValue("")).toBe("");
  });
});

describe("reviewRows", () => {
  const action = { type: "fill_form" as const, values: [
    { target: "Full name", value: "Ada Lovelace" },
    { target: "Card number", value: "4242424242424242" },
    { target: "Password", value: "" },
  ]};
  const fields = [F({ name: "fullname", placeholder: "Full name" }), F({ name: "cc", placeholder: "Card number" }), F({ type: "password", name: "pw", placeholder: "Password" })];

  it("joins captured metadata, blanks secret values, redacts for display", () => {
    const rows = reviewRows(action, fields);
    for (const r of rows) expect(ReviewRowSchema.safeParse(r).success).toBe(true);
    expect(rows[0]).toMatchObject({ target: "Full name", value: "Ada Lovelace", secret: false });
    expect(rows[1].secret).toBe(true);
    expect(rows[1].value).toBe("");           // never round-trips the card number
    expect(rows[1].redacted).toBe("••••42");  // display-only
    expect(rows[2]).toMatchObject({ type: "password", secret: true, value: "" });
  });
  it("survives fields=null", () => {
    expect(reviewRows(action, null)).toHaveLength(3);
  });
  it("marks a label-only password row secret even when metadata can't be joined", () => {
    // Real capture: a password input labeled "Password" may carry name "pw"
    // and no placeholder — findMeta misses, but the row must still be secret.
    const rows = reviewRows(
      { type: "fill_form" as const, values: [{ target: "Password", value: "" }] },
      [F({ type: "password", name: "pw" })],
    );
    expect(rows[0].secret).toBe(true);
    expect(rows[0].value).toBe("");
  });
  it("joins captured question text — builder forms with identical placeholders", () => {
    const rows = reviewRows(
      { type: "fill_form" as const, values: [{ target: "Your name", value: "Ada" }] },
      [F({ question: "Your name", placeholder: "Type your answer here..." })],
    );
    expect(rows[0]).toMatchObject({ target: "Your name", type: "text", secret: false });
  });
});

describe("fillBatchRows — Run-All batch join", () => {
  const expectRowValid = (r: unknown) => {
    const parsed = FillBatchRowSchema.safeParse(r);
    if (!parsed.success) throw new Error(`row shape drift: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
    return r as ReturnType<typeof fillBatchRows>[number];
  };

  it("joins fill_form values to captured metadata (placeholder/question/name/selector)", () => {
    const fields = [
      F({ type: "email", name: "email", placeholder: "Your email", question: "Email address" }),
      F({ name: "fullname", question: "Full name" }),
      F({ type: "tel", name: "phone" }),
      F({ type: "text", selector: "#addr", name: "street" }),
    ];
    const actions = [{
      type: "fill_form" as const,
      values: [
        { target: "Your email", value: "ada@example.com" },
        { target: "Full name", value: "Ada" },
        { target: "phone", value: "555-0100" },
        { target: "#addr", value: "1 Main St", selector: "#addr" },
      ],
    }];
    const rows = fillBatchRows(actions, fields).map(expectRowValid);
    expect(rows.map((r) => r.type)).toEqual(["email", "text", "tel", "text"]); // joined meta types
    expect(rows.every((r) => r.kind === "fill_form")).toBe(true);
    expect(rows[0]).toMatchObject({ vi: 0, secret: false, value: "ada@example.com", redacted: "••••om" });
    expect(rows[1].vi).toBe(1);
  });

  it("blanks secret rows — password type or sensitive target — but keeps the redacted display form", () => {
    const actions = [{
      type: "fill_form" as const,
      values: [
        { target: "Password", value: "hunter2" },
        { target: "card number", value: "4242424242424242" },
      ],
    }];
    const rows = fillBatchRows(actions, [F({ type: "password", name: "pw", placeholder: "Password" })]).map(expectRowValid);
    expect(rows[0]).toMatchObject({ secret: true, value: "", type: "password", redacted: "••••r2" });
    expect(rows[1]).toMatchObject({ secret: true, value: "", redacted: "••••42" });
  });

  it("labels plain fill actions from captured metadata, falls back to the selector", () => {
    const fields = [F({ name: "email", question: "Email address", type: "email" })];
    const actions = [
      { type: "fill" as const, selector: "input[name=email]", value: "ada@example.com" },
      { type: "fill" as const, selector: "#mystery", value: "x" },
    ];
    const rows = fillBatchRows(actions, fields).map(expectRowValid);
    expect(rows[0]).toMatchObject({ kind: "fill", ai: 0, vi: null, target: "Email address", type: "email", secret: false });
    expect(rows[1]).toMatchObject({ kind: "fill", target: "#mystery", type: "" });
  });

  it("blanks a plain fill whose selector or label reads as sensitive", () => {
    const actions = [
      { type: "fill" as const, selector: "input[name=ccnumber]", value: "4242" },
      { type: "fill" as const, selector: "#x", value: "hunter2" },
    ];
    const rows = fillBatchRows(actions, [F({ type: "password", selector: "#x" })]).map(expectRowValid);
    expect(rows[0].secret).toBe(true); // sensitive selector
    expect(rows[0].value).toBe("");
    expect(rows[1].secret).toBe(true); // password-type captured field
    expect(rows[1].value).toBe("");
  });

  it("skips non-fill actions and null entries; tolerates null inputs", () => {
    const actions: unknown[] = [
      { type: "click", selector: "#go" },
      null,
      { type: "fill", selector: "#a", value: "1" },
    ];
    const rows = fillBatchRows(actions, null).map(expectRowValid);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "fill", target: "#a", value: "1" });
    expect(fillBatchRows(null, null)).toEqual([]);
  });
});

describe("isSensitiveSubmitProbe (#266 — recipe click backstop)", () => {
  it("flags a form's submit control by type and by submit-ish text", () => {
    expect(isSensitiveSubmitProbe({ form: true, type: "submit", text: "" })).toBe(true);
    expect(isSensitiveSubmitProbe({ form: true, type: "button", text: "Place order" })).toBe(true);
    expect(isSensitiveSubmitProbe({ form: true, type: "button", text: "PAY NOW" })).toBe(true);
    expect(isSensitiveSubmitProbe({ form: true, type: "button", text: "<button>Checkout</button>" })).toBe(true);
  });
  it("does not flag non-submit clicks or page elements outside a form", () => {
    expect(isSensitiveSubmitProbe({ form: true, type: "button", text: "Next section" })).toBe(false);
    expect(isSensitiveSubmitProbe({ form: false, type: "button", text: "Place order" })).toBe(false);
    expect(isSensitiveSubmitProbe({ form: true, type: "radio", text: "" })).toBe(false);
    expect(isSensitiveSubmitProbe(null)).toBe(false);
    expect(isSensitiveSubmitProbe({})).toBe(false);
  });
});
