import type { BBox } from "@/domain/layout";
import type { Pt } from "@/domain/geometry/path";

export type RawPiece = {
  subpaths: Array<{ points: Pt[]; closed: boolean }>;
  openContour: boolean;
};

export type VectorPiece = {
  id: string;
  index: number;
  label: string;
  openContour: boolean;
  bbox: BBox;
  contour: Pt[];
  holes: Pt[][];
};

export type VectorWarning = { code: string; message: string };

export type VectorParse = {
  format: "svg" | "pdf" | "ai_pdf";
  hasPhysicalUnit: boolean;
  artboard: { x: number; y: number; width: number; height: number; unit: string } | null;
  pieces: VectorPiece[];
  warnings: VectorWarning[];
  unitName: "mm" | "file_unit";
};

export function bboxOf(points: Pt[]): BBox {
  const xs = points.map((pt) => pt.x);
  const ys = points.map((pt) => pt.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

export function classifyPieces(
  raw: RawPiece[],
  warnings: VectorWarning[],
  options: { minClosedArea: number; minOpenSpan: number },
): Omit<VectorPiece, "id" | "index" | "label">[] {
  const pieces: Omit<VectorPiece, "id" | "index" | "label">[] = [];
  for (const item of raw) {
    const all = item.subpaths.flatMap((sub) => sub.points);
    if (all.length < 2) continue;
    const box = bboxOf(all);
    const area = box.width * box.height;
    const open = item.subpaths.some((sub) => !sub.closed) || item.openContour;
    if (open && (box.width < options.minOpenSpan || box.height < options.minOpenSpan)) {
      warnings.push({
        code: "excluded_decoration",
        message: "Bỏ nét hở nhỏ — không tính là mảnh applique.",
      });
      continue;
    }
    if (!open && area < options.minClosedArea) {
      warnings.push({
        code: "excluded_speck",
        message: "Bỏ mảnh kín quá nhỏ — không tính là mảnh applique.",
      });
      continue;
    }
    const scored = item.subpaths.map((sub) => ({ ...sub, box: bboxOf(sub.points) }));
    const holes: Pt[][] = [];
    const outers: Pt[][] = [];
    for (const sub of scored) {
      const probe = sub.points[Math.floor(sub.points.length / 2)] ?? sub.points[0];
      const container = scored.find(
        (other) =>
          other !== sub &&
          other.box.width * other.box.height > sub.box.width * sub.box.height + 1e-6 &&
          containsBox(other.box, sub.box) &&
          pointInside(probe, other.points),
      );
      if (container) holes.push(thin(sub.points));
      else outers.push(thin(sub.points));
    }
    const largest = [...scored].sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height)[0];
    pieces.push({
      openContour: largest ? !largest.closed : open,
      bbox: box,
      contour: outers[0] ?? thin(all),
      holes,
    });
  }
  return pieces;
}

function containsBox(outer: BBox, inner: BBox): boolean {
  return (
    inner.x >= outer.x - 1e-6 &&
    inner.y >= outer.y - 1e-6 &&
    inner.x + inner.width <= outer.x + outer.width + 1e-6 &&
    inner.y + inner.height <= outer.y + outer.height + 1e-6
  );
}

function pointInside(pt: Pt, polygon: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const intersect = a.y > pt.y !== b.y > pt.y && pt.x < ((b.x - a.x) * (pt.y - a.y)) / (b.y - a.y || 1e-12) + a.x;
    if (intersect) inside = !inside;
  }
  return inside;
}

function thin(points: Pt[]): Pt[] {
  if (points.length <= 400) return points;
  const step = Math.ceil(points.length / 400);
  const out = points.filter((_, index) => index % step === 0);
  const last = points[points.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}
