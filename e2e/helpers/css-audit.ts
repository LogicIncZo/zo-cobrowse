// CSS-audit walker (#297) — the audit probe's contrast walker, committed as a
// reusable helper so UX tickets can gate real rendered contrast per theme.
// Walks visible text nodes under a root selector, resolves each node's
// effective background by climbing to the nearest opaque ancestor, and
// returns WCAG contrast ratios + font sizes.

export interface AuditRow {
  text: string;
  fontSize: number;
  ratio: number;
}

export const PANEL_THEMES = ["", "dark", "light", "sepia", "forest", "ocean"] as const;

export async function auditContrast(
  panel: import("@playwright/test").Page,
  rootSelector: string,
): Promise<AuditRow[]> {
  // Freeze transitions/animations first: theme flips re-color via 0.15s CSS
  // transitions, and a headless tab may never advance them — the computed
  // color would then be stuck mid-transition at the pre-flip value.
  await panel.evaluate(() => {
    const st = document.createElement("style");
    st.id = "css-audit-still";
    st.textContent = "*, *::before, *::after { transition: none !important; animation: none !important; }";
    document.head.appendChild(st);
  });
  await panel.evaluate(
    () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))),
  );
  return panel.evaluate((sel): AuditRow[] => {
    const parse = (s: string): [number, number, number, number] => {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) return [0, 0, 0, 1];
      const parts = m[1].split(",").map((x) => parseFloat(x));
      return [parts[0], parts[1], parts[2], parts.length > 3 ? parts[3] : 1];
    };
    const chan = (c: number) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    };
    const lum = (rgb: [number, number, number]) =>
      0.2126 * chan(rgb[0]) + 0.7152 * chan(rgb[1]) + 0.0722 * chan(rgb[2]);
    const ratio = (fg: [number, number, number, number], bg: [number, number, number, number]) => {
      // composite fg alpha over bg first
      const a = fg[3];
      const mixed: [number, number, number] = [
        fg[0] * a + bg[0] * (1 - a),
        fg[1] * a + bg[1] * (1 - a),
        fg[2] * a + bg[2] * (1 - a),
      ];
      const l1 = lum(mixed);
      const l2 = lum([bg[0], bg[1], bg[2]]);
      const [hi, lo] = l1 > l2 ? [l1, l2] : [l2, l1];
      return (hi + 0.05) / (lo + 0.05);
    };
    const effBg = (el: Element): [number, number, number, number] => {
      let n: Element | null = el;
      while (n) {
        const c = parse(getComputedStyle(n).backgroundColor);
        if (c[3] > 0.9) return c;
        n = n.parentElement;
      }
      return [255, 255, 255, 1];
    };
    const root = document.querySelector(sel);
    if (!root) return [];
    const out: AuditRow[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const raw = walker.currentNode.nodeValue?.trim();
      const el = walker.currentNode.parentElement;
      if (!raw || !el) continue;
      if (el.closest("select")) continue; // closed-select internals render in the popup
      const st = getComputedStyle(el);
      if (st.display === "none" || st.visibility === "hidden" || parseFloat(st.opacity) === 0) continue;
      out.push({
        text: raw.slice(0, 24),
        fontSize: parseFloat(st.fontSize),
        ratio: Math.round(ratio(parse(st.color), effBg(el)) * 100) / 100,
      });
    }
    return out;
  }, rootSelector);
}
