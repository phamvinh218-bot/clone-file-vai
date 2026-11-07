import { describe, expect, it } from "vitest";
import { buildLayout, ceilLengthToPx, marginPx, pxToMm, LAYOUT_SPEC } from "@/domain/layout";
import { parseVectorFile } from "@/domain/geometry/parse";
import { AppError } from "@/domain/errors";

describe("10mm allowance at 300 PPI", () => {
  it("ceils 10mm to 119px and does not use the historical 20mm margin", () => {
    expect(LAYOUT_SPEC.allowanceMmEachSide).toBe(10);
    expect(LAYOUT_SPEC.historicalReferenceAllowanceMmEachSide).toBe(20);
    expect(marginPx()).toBe(119);
    expect(ceilLengthToPx(10, 300)).toBe(119);
    expect(ceilLengthToPx(20, 300)).toBe(237);
    expect(pxToMm(119, 300)).toBeGreaterThanOrEqual(10);
  });

  it("sizes the NURSE letters with 10mm panels, not the historical 20mm panels", () => {
    const letters = [
      { id: "N", index: 1, width: 58.64, height: 109.78 },
      { id: "U", index: 2, width: 57.89, height: 97.24 },
      { id: "R", index: 3, width: 56.09, height: 93.77 },
      { id: "S", index: 4, width: 50.63, height: 98.64 },
      { id: "E", index: 5, width: 49.94, height: 107.98 },
    ];
    const perPiece = buildLayout(
      letters.map((letter) => ({
        id: letter.id,
        index: letter.index,
        patternKey: letter.id.toLowerCase(),
        bbox: { x: letter.index * 10, y: 0, width: letter.width, height: letter.height },
      })),
    );
    expect(perPiece.mode).toBe("per_piece");
    expect(perPiece.referenceOrder).toEqual(["N", "U", "R", "S", "E"]);
    expect(perPiece.sheets[0].widthPx).toBe(ceilLengthToPx(58.64) + 238);
    expect(perPiece.sheets[0].widthPx).toBe(931);
    expect(perPiece.sheets.map((sheet) => sheet.pieceIds[0])).toEqual(["N", "U", "R", "S", "E"]);
    for (const sheet of perPiece.sheets) {
      expect(sheet.marginPx).toBe(119);
      expect(sheet.widthMm - sheet.pieces[0].widthMm).toBeGreaterThanOrEqual(20);
      expect(sheet.heightMm - sheet.pieces[0].heightMm).toBeGreaterThanOrEqual(20);
    }

    const same = buildLayout(
      letters.map((letter) => ({
        id: letter.id,
        index: letter.index,
        patternKey: "ke",
        bbox: { x: letter.index * 80, y: 0, width: letter.width, height: letter.height },
      })),
    );
    expect(same.mode).toBe("single_sheet");
    expect(same.sheets).toHaveLength(1);
    expect(same.sheets[0].pieceIds).toEqual(["N", "U", "R", "S", "E"]);
  });

  it("keeps repeated patterns on separate panels once two distinct patterns exist", () => {
    const layout = buildLayout([
      { id: "a", index: 1, patternKey: "hoa", bbox: { x: 0, y: 0, width: 40, height: 20 } },
      { id: "b", index: 2, patternKey: "ke", bbox: { x: 50, y: 0, width: 30, height: 25 } },
      { id: "c", index: 3, patternKey: "hoa", bbox: { x: 90, y: 0, width: 15, height: 15 } },
    ]);
    expect(layout.distinctPatternCount).toBe(2);
    expect(layout.mode).toBe("per_piece");
    expect(layout.sheets.map((sheet) => sheet.pieceIds[0])).toEqual(["a", "b", "c"]);
  });

  it("preserves gaps on one sheet when every piece shares a pattern", () => {
    const layout = buildLayout([
      { id: "a", index: 1, patternKey: "ke", bbox: { x: 0, y: 5, width: 10, height: 10 } },
      { id: "b", index: 2, patternKey: "ke", bbox: { x: 30, y: 0, width: 10, height: 12 } },
    ]);
    expect(layout.mode).toBe("single_sheet");
    const [first, second] = layout.sheets[0].pieces;
    expect(second.xPx - first.xPx).toBeCloseTo((30 / 25.4) * 300, 5);
    const unionWidth = 40;
    expect(layout.sheets[0].widthPx).toBe(ceilLengthToPx(unionWidth) + 238);
  });
});

function svg(body: string, width = "100mm", height = "80mm", view = "0 0 100 80") {
  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="${view}">${body}</svg>`,
  );
}

describe("vector bounds, not artboard", () => {
  it("applies transforms and ignores the viewBox size", () => {
    const parsed = parseVectorFile("letter.svg", svg(`<g transform="translate(15 5)"><rect x="0" y="0" width="20" height="10"/></g>`));
    expect(parsed.hasPhysicalUnit).toBe(true);
    expect(parsed.artboard?.width).toBe(100);
    expect(parsed.pieces).toHaveLength(1);
    expect(parsed.pieces[0].bbox.x).toBeCloseTo(15, 3);
    expect(parsed.pieces[0].bbox.y).toBeCloseTo(5, 3);
    expect(parsed.pieces[0].bbox.width).toBeCloseTo(20, 3);
    expect(parsed.pieces[0].bbox.height).toBeCloseTo(10, 3);
  });

  it("applies a transform list from right to left", () => {
    const parsed = parseVectorFile(
      "scale.svg",
      svg(`<rect x="0" y="0" width="10" height="10" transform="translate(10 0) scale(2)"/>`, "80mm", "80mm", "0 0 80 80"),
    );
    expect(parsed.pieces[0].bbox.x).toBeCloseTo(10, 3);
    expect(parsed.pieces[0].bbox.width).toBeCloseTo(20, 3);
    expect(parsed.pieces[0].bbox.height).toBeCloseTo(20, 3);
  });

  it("keeps an inner hole inside one piece", () => {
    const parsed = parseVectorFile("hole.svg", svg(`<path d="M10 10 H70 V60 H10 Z M20 20 H40 V40 H20 Z"/>`));
    expect(parsed.pieces).toHaveLength(1);
    expect(parsed.pieces[0].holes).toHaveLength(1);
    expect(parsed.pieces[0].bbox.width).toBeCloseTo(60, 3);
    expect(parsed.pieces[0].bbox.height).toBeCloseTo(50, 3);
    expect(parsed.artboard?.width).not.toBeCloseTo(parsed.pieces[0].bbox.width, 0);
  });

  it("uses cubic extrema rather than the endpoints", () => {
    const parsed = parseVectorFile(
      "curve.svg",
      svg(`<path d="M0 0 C0 40 10 40 10 0"/>`, "20mm", "40mm", "0 0 20 40"),
    );
    expect(parsed.pieces[0].bbox.height).toBeGreaterThan(25);
    expect(parsed.pieces[0].bbox.height).toBeLessThan(35);
  });

  it("includes the bulge of an arc", () => {
    const parsed = parseVectorFile(
      "arc.svg",
      svg(`<path d="M0 10 A10 10 0 0 1 20 10"/>`, "30mm", "30mm", "0 0 30 30"),
    );
    expect(parsed.pieces[0].bbox.width).toBeGreaterThan(19);
    expect(parsed.pieces[0].bbox.height).toBeGreaterThan(5);
  });

  it("does not treat a px file as print-scaled millimetres", () => {
    const parsed = parseVectorFile("preview.svg", svg(`<rect x="5" y="5" width="30" height="20"/>`, "100", "80"));
    expect(parsed.hasPhysicalUnit).toBe(false);
    expect(parsed.unitName).toBe("file_unit");
    expect(parsed.pieces[0].bbox).toMatchObject({ x: 5, y: 5, width: 30, height: 20 });
  });

  it("rejects active SVG and non-PDF Illustrator files", () => {
    expect(() => parseVectorFile("bad.svg", svg(`<script>alert(1)</script><rect width="30" height="30"/>`))).toThrow(AppError);
    expect(() => parseVectorFile("art.ai", Buffer.from("%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator\n"))).toThrow(
      /PDF hoặc SVG/,
    );
  });

  it("reads path bounds from a PDF and from a PDF-compatible AI file, ignoring the media box", () => {
    const pdf = pdfWith(`10 20 30 40 re\nh\nf\n`, [0, 0, 400, 300]);
    const parsed = parseVectorFile("cut.pdf", pdf);
    const mm = 25.4 / 72;
    expect(parsed.artboard?.width).toBeCloseTo(400 * mm, 3);
    expect(parsed.pieces).toHaveLength(1);
    expect(parsed.pieces[0].bbox.width).toBeCloseTo(30 * mm, 3);
    expect(parsed.pieces[0].bbox.height).toBeCloseTo(40 * mm, 3);
    expect(parsed.pieces[0].bbox.width).toBeLessThan(parsed.artboard!.width / 2);

    const ai = parseVectorFile("cut.ai", pdf);
    expect(ai.format).toBe("ai_pdf");
    expect(ai.pieces[0].bbox.width).toBeCloseTo(30 * mm, 3);
  });

  it("applies a PDF transformation matrix", () => {
    const pdf = pdfWith(`q\n2 0 0 2 100 50 cm\n0 0 10 10 re\nh\nf\nQ\n`, [0, 0, 500, 400]);
    const parsed = parseVectorFile("moved.pdf", pdf);
    const mm = 25.4 / 72;
    expect(parsed.pieces[0].bbox.width).toBeCloseTo(20 * mm, 2);
    expect(parsed.pieces[0].bbox.height).toBeCloseTo(20 * mm, 2);
  });

  it("ignores PDF text and keeps a compound hole", () => {
    const pdf = pdfWith(`BT\n(HELLO) Tj\nET\n10 10 80 60 re\nh\n30 30 20 20 re\nh\nf\n`, [0, 0, 320, 200]);
    const parsed = parseVectorFile("letter.pdf", pdf);
    expect(parsed.warnings.some((warning) => warning.code === "excluded_text")).toBe(true);
    expect(parsed.pieces).toHaveLength(1);
    expect(parsed.pieces[0].holes.length).toBe(1);
    expect(parsed.pieces[0].bbox.width).toBeCloseTo(80 * (25.4 / 72), 2);
  });
});

function pdfWith(content: string, media: number[]): Buffer {
  const stream = Buffer.from(content);
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [${media.join(" ")}] /Contents 4 0 R >>\nendobj\n`,
    `4 0 obj\n<< /Length ${stream.length} >>\nstream\n${content}endstream\nendobj\n`,
  ];
  return Buffer.from(`%PDF-1.4\n${objects.join("")}trailer\n<< /Root 1 0 R >>\n%%EOF\n`);
}
