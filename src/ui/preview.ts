import type { BBox } from "@/domain/layout";

type Piece = { bbox: BBox; contour: Array<{ x: number; y: number }> };

export function geometryPreviewSvg(pieces: Piece[]): string {
  if (pieces.length === 0) return "";
  const minX = Math.min(...pieces.map((piece) => piece.bbox.x));
  const minY = Math.min(...pieces.map((piece) => piece.bbox.y));
  const maxX = Math.max(...pieces.map((piece) => piece.bbox.x + piece.bbox.width));
  const maxY = Math.max(...pieces.map((piece) => piece.bbox.y + piece.bbox.height));
  const width = Math.max(maxX - minX, 1);
  const height = Math.max(maxY - minY, 1);
  const pad = Math.max(width, height) * 0.08;
  const num = (value: number) => (Number.isFinite(value) ? value.toFixed(2) : "0");
  const shapes = pieces
    .map((piece) => {
      const points = (piece.contour.length > 1 ? piece.contour : corners(piece.bbox))
        .map((pt) => `${num(pt.x)},${num(pt.y)}`)
        .join(" ");
      return `<polyline points="${points}" fill="none" stroke="#8c2f39" stroke-width="${num(Math.max(width, height) / 180)}" />`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${num(minX - pad)} ${num(minY - pad)} ${num(width + pad * 2)} ${num(height + pad * 2)}" role="img">${shapes}</svg>`;
}

function corners(box: BBox) {
  return [
    { x: box.x, y: box.y },
    { x: box.x + box.width, y: box.y },
    { x: box.x + box.width, y: box.y + box.height },
    { x: box.x, y: box.y + box.height },
    { x: box.x, y: box.y },
  ];
}
