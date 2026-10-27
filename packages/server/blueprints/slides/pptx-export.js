// PowerPoint export with PptxGenJS (pptxgen.bundle.js, loaded before this file). Every slide becomes
// native, editable PowerPoint content that follows the HTML layouts: the 1280×720 canvas maps to a
// 13.33×7.5 in slide (1 px = 1/96 in; font px × 0.75 = pt). Speaker notes go into the notes pane.
(function () {
  const IN = (px) => Math.round((px / 96) * 10000) / 10000;
  const PT = (px) => Math.round(px * 0.75 * 100) / 100;
  const H = (c) => String(c).replace("#", "").toUpperCase();
  /** Colour a at opacity t over b (hex without #). */
  function mix(a, b, t) {
    const p = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
    const [x, y] = [p(a), p(b)];
    return x.map((v, i) => Math.round(v * t + y[i] * (1 - t)).toString(16).padStart(2, "0")).join("").toUpperCase();
  }
  const PAL = ["50DCE1", "FF6B5A", "F2B84B", "9D9F9E", "8E7CC3"];
  const THEMES = {
    paper: { bg: "FBF9F4", fg: "1D1B16", accent: "D9480F", onAccent: "FFF8F0", font: "Georgia" },
    midnight: { bg: "10131A", fg: "E9ECF3", accent: "7AA2FF", onAccent: "0B0E14", font: "Segoe UI" },
    sunset: { bg: "5C2A3A", fg: "FFF3E6", accent: "FFB86B", onAccent: "2D1B3D", font: "Segoe UI" },
    forest: { bg: "F1F4EC", fg: "1F2D1C", accent: "2F6B3A", onAccent: "F1F4EC", font: "Georgia" },
  };

  /** Colours, fonts and geometry for one slide (mirrors rosenxt.css and the inline theme CSS). */
  function lookFor(theme, s) {
    if (theme === "rosenxt") {
      const lightDefault = s.layout === "section" || s.layout === "big-number";
      const light = s.layout === "title" ? false : s.variant === "light" || (lightDefault && s.variant !== "dark");
      const base = { rx: true, head: "Arial Black", body: "Arial", headBold: false, L: 44, T: 40, B: 80, muted: "9D9F9E" };
      if (light) return { ...base, light: true, bg: "FFFFFF", fg: "1D211C", title: "1D211C", sub: "5C6062", accent: "1D211C", marker: "1D211C", bar: "1FB5BB", hot: "E5483A", tblHot: "D63A2C", rule: "1D211C", track: "808684" };
      return { ...base, light: false, bg: "1D211C", fg: "FFFFFF", title: "50DCE1", sub: mix("FFFFFF", "1D211C", 0.75), accent: "50DCE1", marker: "50DCE1", bar: "50DCE1", hot: "FF6B5A", tblHot: "FF6B5A", rule: "50DCE1", track: "808684" };
    }
    const t = THEMES[theme] || THEMES.paper;
    const section = s.layout === "section";
    const bg = section ? t.accent : t.bg;
    const fg = section ? t.onAccent : t.fg;
    return { rx: false, light: true, head: t.font, body: t.font, headBold: true, L: 96, T: 80, B: 80, bg, fg, title: fg, sub: mix(fg, bg, 0.7), accent: section ? fg : t.accent, marker: t.accent, bar: t.accent, hot: "E5483A", tblHot: "D63A2C", rule: t.accent, track: "808684", muted: mix(fg, bg, 0.55) };
  }

  const svgData = (svg) => "image/svg+xml;base64," + (typeof btoa === "function" ? btoa(unescape(encodeURIComponent(svg))) : Buffer.from(svg).toString("base64"));

  function buildDeckPptx(PptxGenJS, deck, opts = {}) {
    const pptx = new PptxGenJS();
    pptx.layout = "LAYOUT_WIDE"; // 13.333 × 7.5 in = 1280 × 720 px
    pptx.title = deck.title || "Deck";
    if (deck.theme === "rosenxt") pptx.company = "Rosenxt";
    // Explicit pixel size (3× the viewBox) so the PNG fallback PptxGenJS draws is sharp and never 0×0.
    const markSvg = opts.mark ? opts.mark.replace(/\sclass="[^"]*"/, "").replace("<svg ", '<svg width="1603" height="225" ') : null;
    // In browsers the wordmark goes in as a PNG drawn from its vector path (opts.markPng):
    // PptxGenJS's own SVG handling has to load the SVG as an image, which fails in the sandbox.
    const mark = opts.markPng || (markSvg ? svgData(markSvg) : null);
    const date = opts.date || "";
    let section = 0;

    deck.slides.forEach((s, i) => {
      const k = lookFor(deck.theme, s);
      const sl = pptx.addSlide();
      sl.background = { color: k.bg };
      const W = 1280 - 2 * k.L;
      const text = (value, box, o = {}) => {
        if (value === undefined || value === null || value === "") return;
        sl.addText(String(value), { x: IN(box.x), y: IN(box.y), w: IN(box.w), h: IN(box.h), margin: 0, fontFace: k.body, color: k.fg, valign: "top", ...o });
      };
      const head = (value, box, px, o = {}) => text(value, box, { fontFace: k.head, bold: k.headBold, fontSize: PT(px), color: k.title, ...o });
      const titleTop = (px = k.rx ? 32 : 64) => {
        head(s.title, { x: k.L, y: k.T, w: W, h: px * 1.4 }, px, { valign: "top", fit: "shrink" });
        return k.T + px * 1.2;
      };
      const bullets = (items, box, px, o = {}) => {
        const list = (items || []).filter((b) => String(b).trim());
        if (!list.length) return;
        sl.addText(
          list.map((b) => ({ text: String(b), options: { bullet: { indent: PT(px * 1.1) }, color: k.fg, breakLine: true } })),
          { x: IN(box.x), y: IN(box.y), w: IN(box.w), h: IN(box.h), margin: 0, fontFace: k.body, fontSize: PT(px), color: k.fg, valign: "top", lineSpacingMultiple: k.rx ? 1.35 : 1.45, paraSpaceAfter: 0, fit: "shrink", ...o },
        );
      };

      switch (s.layout) {
        case "title": {
          if (k.rx) {
            if (mark) sl.addImage({ data: mark, x: IN(44), y: IN(56), w: IN(540), h: IN(540 * 74.88 / 534.24) });
            head(s.title, { x: 44, y: 230, w: 1192, h: 240 }, 52, { color: "FFFFFF", valign: "bottom", fit: "shrink" });
            text(s.subtitle, { x: 44, y: 488, w: 1192, h: 44 }, { fontSize: PT(24), color: mix("FFFFFF", "1D211C", 0.8) });
          } else {
            sl.addShape(pptx.ShapeType.rect, { x: IN(96), y: IN(96), w: IN(120), h: IN(12), fill: { color: k.accent }, line: { type: "none" } });
            head(s.title, { x: 96, y: 200, w: 1088, h: 300 }, 92, { valign: "bottom", fit: "shrink" });
            text(s.subtitle, { x: 96, y: 520, w: 1088, h: 70 }, { fontSize: PT(30), color: k.sub });
          }
          break;
        }
        case "section": {
          section++;
          if (k.rx) {
            const hasSub = !!s.subtitle;
            const titleY = hasSub ? 566 : 604;
            text(`${String(section).padStart(2, "0")}.`, { x: 44, y: titleY - 112, w: 600, h: 110 }, { fontFace: "Arial Black", fontSize: PT(105), color: "1D211C", valign: "bottom" });
            head(s.title, { x: 44, y: titleY, w: 1192, h: 52 }, 37, { color: "1D211C", valign: "bottom", fit: "shrink" });
            text(s.subtitle, { x: 44, y: titleY + 56, w: 1192, h: 32 }, { fontSize: PT(20), color: "5C6062" });
          } else {
            sl.addText(
              [
                { text: String(s.title || ""), options: { fontFace: k.head, bold: true, fontSize: PT(84), color: k.fg, breakLine: true } },
                ...(s.subtitle ? [{ text: String(s.subtitle), options: { fontSize: PT(30), color: k.sub } }] : []),
              ],
              { x: IN(96), y: IN(80), w: IN(1088), h: IN(560), margin: 0, fontFace: k.body, valign: "middle", fit: "shrink" },
            );
          }
          break;
        }
        case "bullets": {
          const y = titleTop() + (k.rx ? 72 : 40);
          const indent = k.rx ? 120 : 0;
          bullets(s.bullets, { x: k.L + indent, y, w: W - indent, h: 720 - k.B - y }, k.rx ? 24 : 34);
          break;
        }
        case "two-column": {
          const y = titleTop() + (k.rx ? 72 : 40);
          const left = k.rx ? 60 : 0;
          const gap = k.rx ? 48 : 56;
          const colW = (W - left - gap) / 2;
          [["leftTitle", "left"], ["rightTitle", "right"]].forEach(([t, list], c) => {
            const x = k.L + left + c * (colW + gap);
            const hpx = k.rx ? 24 : 30;
            head(s[t], { x, y, w: colW, h: hpx * 1.5 }, hpx, { color: k.accent });
            bullets(s[list], { x, y: y + (s[t] ? hpx * 1.5 + 12 : 0), w: colW, h: 720 - k.B - y - hpx * 1.5 }, k.rx ? 22 : 28);
          });
          break;
        }
        case "quote": {
          const px = k.rx ? 30 : 54;
          sl.addText(
            [
              { text: "\u201C", options: { fontSize: PT(k.rx ? 90 : 140), color: k.rx ? "50DCE1" : k.accent, breakLine: true } },
              { text: String(s.quote || ""), options: { fontSize: PT(px), color: k.fg, breakLine: true } },
              ...(s.attribution ? [{ text: String(s.attribution), options: { fontSize: PT(k.rx ? 20 : 26), color: k.sub } }] : []),
            ],
            { x: IN(k.L), y: IN(k.T), w: IN(W), h: IN(720 - k.T - k.B), margin: 0, fontFace: k.rx ? "Arial" : k.body, valign: k.rx ? "top" : "middle", paraSpaceAfter: PT(12), fit: "shrink" },
          );
          break;
        }
        case "big-number": {
          if (k.rx) {
            head(s.title, { x: 44, y: 40, w: 1192, h: 44 }, 32, { color: "1D211C" });
            text(s.number, { x: 44, y: 112, w: 1192, h: 130 }, { fontFace: "Arial Black", fontSize: PT(110), color: "1D211C", valign: "top" });
            text(s.caption, { x: 44, y: 242, w: 1192, h: 80 }, { fontSize: PT(27), color: "5C6062" });
          } else {
            sl.addText(
              [
                ...(s.title ? [{ text: String(s.title), options: { fontFace: k.head, bold: true, fontSize: PT(64), color: k.fg, breakLine: true } }] : []),
                { text: String(s.number || ""), options: { fontFace: k.head, bold: true, fontSize: PT(220), color: k.accent, breakLine: true } },
                ...(s.caption ? [{ text: String(s.caption), options: { fontSize: PT(32), color: k.sub } }] : []),
              ],
              { x: IN(96), y: IN(80), w: IN(1088), h: IN(560), margin: 0, fontFace: k.body, valign: "middle", fit: "shrink" },
            );
          }
          break;
        }
        case "chart": {
          let y = titleTop() + 26;
          const c = s.chart || {};
          const items = c.items || [];
          const labelW = 290, gapX = 16, rowH = 38, gapY = 14;
          const trackX = k.L + labelW + gapX, trackW = W - labelW - gapX;
          if (c.kind === "stacked" && (c.legend || []).length) {
            let lx = trackX;
            (c.legend || []).forEach((l, n) => {
              sl.addShape(pptx.ShapeType.rect, { x: IN(lx), y: IN(y + 3), w: IN(16), h: IN(16), fill: { color: H(l.color || PAL[n % 5]) }, line: { type: "none" } });
              const w = 30 + String(l.name).length * 10;
              text(l.name, { x: lx + 24, y, w, h: 22 }, { fontSize: PT(18), valign: "middle" });
              lx += 24 + w + 10;
            });
            y += 22 + gapY;
          }
          const max = c.max || Math.max(...items.map((it) => Number(it.value) || 0), 1);
          for (const it of items) {
            text(it.label, { x: k.L, y, w: labelW, h: rowH }, { fontSize: PT(20), align: "right", valign: "middle" });
            sl.addShape(pptx.ShapeType.rect, { x: IN(trackX), y: IN(y), w: IN(trackW), h: IN(rowH), fill: { color: k.track, transparency: 78 }, line: { type: "none" } });
            if (c.kind === "stacked") {
              const parts = it.parts || [];
              const tot = parts.reduce((a, b) => a + (Number(b) || 0), 0) || 1;
              let x = trackX;
              parts.forEach((p, n) => {
                const w = (Number(p) || 0) / tot * trackW;
                if (w <= 0) return;
                sl.addText(String(p), { shape: pptx.ShapeType.rect, x: IN(x), y: IN(y), w: IN(w), h: IN(rowH), margin: 0, fill: { color: H(((c.legend || [])[n] || {}).color || PAL[n % 5]) }, line: { type: "none" }, fontFace: k.body, fontSize: PT(18), bold: true, color: "1D211C", align: "center", valign: "middle" });
                x += w;
              });
            } else {
              const w = Math.max(0, Math.min(1, (Number(it.value) || 0) / max)) * trackW;
              if (w > 0) sl.addShape(pptx.ShapeType.rect, { x: IN(trackX), y: IN(y), w: IN(w), h: IN(rowH), fill: { color: it.hot ? k.hot : k.bar }, line: { type: "none" } });
              text(it.text ?? `${it.value}${c.unit || ""}`, { x: trackX + 12, y, w: Math.max(trackW - 12, 60), h: rowH }, { fontSize: PT(20), bold: true, color: w > 60 ? "1D211C" : k.fg, valign: "middle" });
            }
            y += rowH + gapY;
          }
          text(s.caption, { x: k.L, y: y + 4, w: W, h: 60 }, { fontSize: PT(20), color: "9D9F9E" });
          break;
        }
        case "table": {
          const y = titleTop() + 26;
          const cols = s.columns || [];
          const hl = s.highlight || [];
          const align = (c) => (s.leftAll || c < 2 ? "left" : "right");
          const none = { type: "none" };
          const header = cols.map((c, n) => ({ text: String(c), options: { bold: true, fontSize: PT(18), color: k.fg, align: align(n), border: [none, none, { type: "solid", pt: 2.25, color: k.rule }, none] } }));
          const body = (s.rows || []).map((r, ri) =>
            r.map((c, n) => ({ text: String(c ?? ""), options: { fontSize: PT(22), color: hl.includes(ri) ? k.tblHot : k.fg, bold: hl.includes(ri), align: align(n), border: [none, none, { type: "solid", pt: 0.75, color: mix("9A9E9D", k.bg, 0.35) }, none] } })),
          );
          const rows = cols.length ? [header, ...body] : body;
          if (rows.length) {
            // Size columns like the browser's auto table layout (by content), then estimate wrapped
            // row heights so the caption lands below the table.
            const PAD_X = 28, PAD_Y = 21;
            const textW = (t, px, bold) => String(t).length * px * (bold ? 0.54 : 0.48);
            const n = Math.max(...rows.map((r) => r.length));
            const want = Array.from({ length: n }, (_, c) => Math.max(60, ...rows.map((r, ri) => (r[c] ? textW(r[c].text, ri === 0 && cols.length ? 18 : 22, r[c].options.bold) + PAD_X : 0))));
            const total = want.reduce((a, b) => a + b, 0);
            const colPx = want.map((w) => (w / total) * W);
            const heights = rows.map((r, ri) => {
              const px = ri === 0 && cols.length ? 18 : 22;
              const lines = Math.max(1, ...r.map((cell, c) => Math.ceil(textW(cell.text, px, cell.options.bold) / Math.max(colPx[c] - PAD_X, 20))));
              return lines * px * 1.2 + PAD_Y;
            });
            sl.addTable(rows, { x: IN(k.L), y: IN(y), w: IN(W), colW: colPx.map(IN), rowH: heights.map(IN), fontFace: k.body, margin: [10, 14, 10, 14].map((v) => PT(v)), autoPage: false });
            text(s.caption, { x: k.L, y: y + heights.reduce((a, b) => a + b, 0) + 16, w: W, h: 50 }, { fontSize: PT(20), color: "9D9F9E" });
          } else text(s.caption, { x: k.L, y, w: W, h: 50 }, { fontSize: PT(20), color: "9D9F9E" });
          break;
        }
        default:
          head(s.title, { x: k.L, y: k.T, w: W, h: 60 }, k.rx ? 32 : 64);
      }

      // Rosenxt footer: number | date | deck title · disclaimer · wordmark (not on the cover).
      if (k.rx && s.layout !== "title") {
        sl.addShape(pptx.ShapeType.line, { x: 0, y: IN(674), w: IN(1280), h: 0, line: { color: "9A9E9D", width: 0.75, transparency: 70 } });
        sl.addText(
          [
            { text: String(i + 1), options: { color: "9D9F9E" } },
            { text: "   |   ", options: { color: "50DCE1" } },
            { text: date, options: { color: "9D9F9E" } },
            { text: "   |   ", options: { color: "50DCE1" } },
            { text: String(deck.title || ""), options: { color: "9D9F9E" } },
          ],
          { x: IN(40), y: IN(674), w: IN(660), h: IN(46), margin: 0, fontFace: "Arial", fontSize: PT(12), valign: "middle" },
        );
        text("This document is the property of Rosenxt Holding AG who will safeguard its rights according to the civil and penal provisions of law. No part of this document may be reproduced or disclosed to any other party without the prior permission of Rosenxt.", { x: 712, y: 677, w: 360, h: 40 }, { fontSize: PT(8.5), color: "9D9F9E", valign: "middle" });
        if (mark) sl.addImage({ data: mark, x: IN(1086), y: IN(720 - 12 - 168 * 74.88 / 534.24), w: IN(168), h: IN(168 * 74.88 / 534.24) });
      } else if (!k.rx) {
        text(String(i + 1), { x: 1280 - 96 - 80, y: 720 - 46, w: 80, h: 24 }, { fontSize: PT(14), color: k.muted, align: "right" });
      }
      if (s.notes) sl.addNotes(String(s.notes));
    });
    return pptx;
  }

  /** An SVG's paths drawn onto a canvas (no image loading, so it works in a sandboxed frame) → "image/png;base64,…". */
  function svgToPng(svg, scale = 3) {
    const vb = /viewBox="([\d.\s-]+)"/.exec(svg);
    if (!vb || typeof document === "undefined") return null;
    const [, , w, h] = vb[1].trim().split(/\s+/).map(Number);
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);
    for (const m of svg.matchAll(/<path\b([^>]*)>/g)) {
      const d = /\sd="([^"]+)"/.exec(m[1]);
      if (!d) continue;
      ctx.fillStyle = (/fill="([^"]+)"/.exec(m[1]) || [, "#000"])[1];
      ctx.fill(new Path2D(d[1]), /fill-rule="evenodd"/.test(m[1]) ? "evenodd" : "nonzero");
    }
    return canvas.toDataURL("image/png").replace(/^data:/, "");
  }

  /** Build and download the deck. */
  async function exportDeckPptx(deck, opts = {}) {
    if (typeof PptxGenJS === "undefined") throw new Error("PptxGenJS didn't load");
    const markPng = opts.mark ? svgToPng(opts.mark) : null;
    const pptx = buildDeckPptx(PptxGenJS, deck, { ...opts, markPng });
    const name = String(deck.title || "deck").replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 120) || "deck";
    // A data: URL rather than pptx.writeFile()'s blob URL: module frames are sandboxed (opaque origin),
    // and Chrome cancels downloads of blob:null URLs made there.
    const b64 = await pptx.write({ outputType: "base64" });
    const a = document.createElement("a");
    a.href = "data:application/vnd.openxmlformats-officedocument.presentationml.presentation;base64," + b64;
    a.download = `${name}.pptx`;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 1000);
  }

  const g = typeof window !== "undefined" ? window : globalThis;
  g.buildDeckPptx = buildDeckPptx;
  g.exportDeckPptx = exportDeckPptx;
  g.deckSvgToPng = svgToPng;
})();
