import specJson from "@/spec/applique-layout.v1.json";

export const LAYOUT_SPEC = specJson;

export type BBox = { x: number; y: number; width: number; height: number };

export type LayoutInputPiece = {
  id: string;
  index: number;
  patternKey: string;
  bbox: BBox;
};

export type PlacedPiece = {
  id: string;
  index: number;
  xPx: number;
  yPx: number;
  widthMm: number;
  heightMm: number;
};

export type LayoutSheet = {
  id: string;
  pieceIds: string[];
  widthPx: number;
  heightPx: number;
  widthMm: number;
  heightMm: number;
  marginPx: number;
  proofXPx: number;
  pieces: PlacedPiece[];
};

export type LayoutResult = {
  specVersion: string;
  mode: "single_sheet" | "per_piece";
  distinctPatternCount: number;
  ppi: number;
  allowanceMmEachSide: number;
  marginPx: number;
  marginMm: number;
  referenceOrder: string[];
  sheets: LayoutSheet[];
};

/** Ceil a millimetre length to whole pixels. Exact integer division, biased to coverage. */
export function ceilLengthToPx(lengthMm: number, ppi = LAYOUT_SPEC.ppi): number {
  if (!Number.isFinite(lengthMm) || lengthMm < 0 || !Number.isFinite(ppi) || ppi <= 0) {
    throw new Error("Invalid length or resolution");
  }
  const micro = Math.round(lengthMm * 1000);
  const numerator = micro * ppi;
  const denom = 25400;
  if (numerator <= 0) return 0;
  return Math.floor((numerator + denom - 1) / denom);
}

export function pxToMm(px: number, ppi = LAYOUT_SPEC.ppi): number {
  return (px / ppi) * 25.4;
}

export function marginPx(spec: { allowanceMmEachSide: number; ppi: number } = LAYOUT_SPEC): number {
  return ceilLengthToPx(spec.allowanceMmEachSide, spec.ppi);
}

function unionBox(boxes: BBox[]): BBox {
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.width));
  const maxY = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function sheetSize(widthMm: number, heightMm: number, margin: number, ppi: number) {
  const contentW = ceilLengthToPx(widthMm, ppi);
  const contentH = ceilLengthToPx(heightMm, ppi);
  const widthPx = contentW + 2 * margin;
  const heightPx = contentH + 2 * margin;
  return {
    widthPx,
    heightPx,
    widthMm: pxToMm(widthPx, ppi),
    heightMm: pxToMm(heightPx, ppi),
  };
}

export function buildLayout(
  pieces: LayoutInputPiece[],
  spec: { version: string; allowanceMmEachSide: number; ppi: number } = LAYOUT_SPEC,
): LayoutResult {
  if (pieces.length === 0) {
    throw new Error("At least one applique piece is required");
  }
  const ordered = [...pieces].sort((a, b) => a.index - b.index || a.id.localeCompare(b.id));
  const keys = new Set(ordered.map((piece) => piece.patternKey));
  const mode = keys.size >= 2 ? "per_piece" : "single_sheet";
  const edge = marginPx(spec);
  const scale = spec.ppi / 25.4;
  let sheets: LayoutSheet[];
  if (mode === "single_sheet") {
    const union = unionBox(ordered.map((piece) => piece.bbox));
    const size = sheetSize(union.width, union.height, edge, spec.ppi);
    sheets = [
      {
        id: "sheet-1",
        pieceIds: ordered.map((piece) => piece.id),
        ...size,
        marginPx: edge,
        proofXPx: 0,
        pieces: ordered.map((piece) => ({
          id: piece.id,
          index: piece.index,
          xPx: edge + (piece.bbox.x - union.x) * scale,
          yPx: edge + (piece.bbox.y - union.y) * scale,
          widthMm: piece.bbox.width,
          heightMm: piece.bbox.height,
        })),
      },
    ];
  } else {
    let cursor = 0;
    sheets = ordered.map((piece) => {
      const size = sheetSize(piece.bbox.width, piece.bbox.height, edge, spec.ppi);
      const sheet: LayoutSheet = {
        id: `panel-${piece.index}`,
        pieceIds: [piece.id],
        ...size,
        marginPx: edge,
        proofXPx: cursor,
        pieces: [
          {
            id: piece.id,
            index: piece.index,
            xPx: edge,
            yPx: edge,
            widthMm: piece.bbox.width,
            heightMm: piece.bbox.height,
          },
        ],
      };
      cursor += size.widthPx;
      return sheet;
    });
  }
  return {
    specVersion: spec.version,
    mode,
    distinctPatternCount: keys.size,
    ppi: spec.ppi,
    allowanceMmEachSide: spec.allowanceMmEachSide,
    marginPx: edge,
    marginMm: pxToMm(edge, spec.ppi),
    referenceOrder: ordered.map((piece) => piece.id),
    sheets,
  };
}
