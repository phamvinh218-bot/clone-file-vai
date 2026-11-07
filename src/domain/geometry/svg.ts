import { XMLParser } from "fast-xml-parser";
import { AppError } from "@/domain/errors";
import { apply, IDENTITY, multiply, parseTransformList, type Matrix } from "@/domain/geometry/matrix";
import { bboxOf, classifyPieces, type RawPiece, type VectorParse, type VectorWarning } from "@/domain/geometry/model";
import { parseSvgPath, type Pt, type Subpath } from "@/domain/geometry/path";

type Attrs = Record<string, string>;
type XmlNode = Record<string, unknown>;

const parser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  processEntities: false,
  allowBooleanAttributes: true,
  trimValues: true,
});

export function parseSvg(bytes: Buffer): VectorParse {
  const text = bytes.toString("utf8");
  if (text.includes("\u0000")) {
    throw new AppError("invalid_svg", "SVG chứa byte null.", 422);
  }
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) {
    throw new AppError("svg_doctype", "SVG có DOCTYPE hoặc ENTITY. Xuất lại SVG không khai báo thực thể.", 422);
  }
  if (/<script|<\/script|javascript:|foreignObject|<iframe|<embed|<object|on[a-z]+\s*=/i.test(text)) {
    throw new AppError("svg_active_content", "SVG có script hoặc nội dung nhúng. File bị từ chối.", 422);
  }
  const urls = text.match(/https?:\/\/[^\s"'<>]+/gi) ?? [];
  for (const url of urls) {
    const allowed = url.startsWith("http://www.w3.org/2000/svg") || url.startsWith("http://www.w3.org/1999/xlink");
    if (!allowed) {
      throw new AppError("svg_external_ref", "SVG tham chiếu URL ngoài. File bị từ chối, server không tải URL đó.", 422);
    }
  }
  let tree: unknown;
  try {
    tree = parser.parse(text);
  } catch {
    throw new AppError("invalid_svg", "Không đọc được XML của SVG.", 422);
  }
  if (!Array.isArray(tree)) throw new AppError("invalid_svg", "SVG không có phần tử gốc.", 422);
  const warnings: VectorWarning[] = [];
  let textSkipped = 0;
  const raw: RawPiece[] = [];
  let artboard: VectorParse["artboard"] = null;
  let mmPerUserX: number | null = null;
  let mmPerUserY: number | null = null;
  let viewMinX = 0;
  let viewMinY = 0;

  const visit = (nodes: unknown, ctm: Matrix) => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const rec = node as XmlNode;
      const attrs = (rec[":@"] ?? {}) as Attrs;
      for (const key of Object.keys(rec)) {
        if (key === ":@" || key === "?xml") continue;
        const children = rec[key];
        const name = key.toLowerCase();
        if (attrs.display === "none" || attrs.visibility === "hidden") continue;
        if (name === "defs" || name === "clippath" || name === "mask" || name === "symbol" || name === "style" || name === "metadata" || name === "title" || name === "desc") {
          continue;
        }
        if (name === "text" || name === "tspan" || name === "textpath") {
          textSkipped += 1;
          continue;
        }
        if (name === "use" || name === "image") {
          warnings.push({ code: "svg_reference_skipped", message: "Bỏ thẻ use/image. Hãy expand hình trong file vector." });
          continue;
        }
        const next = multiply(ctm, parseTransformList(attrs.transform));
        if (name === "svg" || name === "g") {
          if (name === "svg" && artboard == null) {
            const mapped = readViewport(attrs, warnings);
            artboard = mapped.artboard;
            mmPerUserX = mapped.mmPerUserX;
            mmPerUserY = mapped.mmPerUserY;
            viewMinX = mapped.viewMinX;
            viewMinY = mapped.viewMinY;
          }
          visit(children, next);
          continue;
        }
        const subs = shapeSubpaths(name, attrs, next, warnings);
        if (subs) raw.push({ subpaths: subs, openContour: subs.some((sub) => !sub.closed) });
      }
    }
  };
  visit(tree, IDENTITY);
  if (textSkipped) {
    warnings.push({ code: "excluded_text", message: `Bỏ ${textSkipped} khối chữ. Chữ thêu không phải mảnh applique.` });
  }
  const hasPhysicalUnit = mmPerUserX != null && mmPerUserY != null;
  const scale = (points: Pt[], sx: number, sy: number): Pt[] =>
    points.map((pt) => ({ x: (pt.x - viewMinX) * sx, y: (pt.y - viewMinY) * sy }));
  const scaledRaw: RawPiece[] = hasPhysicalUnit
    ? raw.map((item) => ({
        openContour: item.openContour,
        subpaths: item.subpaths.map((sub) => ({ closed: sub.closed, points: scale(sub.points, mmPerUserX!, mmPerUserY!) })),
      }))
    : raw;
  const classified = classifyPieces(scaledRaw, warnings, { minClosedArea: 1, minOpenSpan: 8 });
  if (classified.length === 0) {
    throw new AppError("no_applique_pieces", "Không tìm thấy mảnh applique. Chữ và nét trang trí không được tính.", 422);
  }
  return {
    format: "svg",
    hasPhysicalUnit,
    artboard,
    unitName: hasPhysicalUnit ? "mm" : "file_unit",
    warnings,
    pieces: classified.map((piece, index) => ({
      ...piece,
      id: `piece-${index + 1}`,
      index: index + 1,
      label: `Mảnh ${index + 1}`,
    })),
  };
}

function readViewport(attrs: Attrs, warnings: VectorWarning[]) {
  const width = parseLength(attrs.width);
  const height = parseLength(attrs.height);
  const view = (attrs.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
  const hasView = view.length === 4 && view.every((n) => Number.isFinite(n)) && view[2] > 0 && view[3] > 0;
  const widthMm = width ? lengthToMm(width.n, width.unit) : null;
  const heightMm = height ? lengthToMm(height.n, height.unit) : null;
  let mmPerUserX: number | null = null;
  let mmPerUserY: number | null = null;
  if (hasView && widthMm != null && heightMm != null) {
    mmPerUserX = widthMm / view[2];
    mmPerUserY = heightMm / view[3];
  } else if ((widthMm != null || heightMm != null) && !hasView) {
    warnings.push({
      code: "svg_viewport_without_viewbox",
      message: "SVG có khổ vật lý nhưng không có viewBox. Không dùng khổ đó làm kích thước cắt, và chưa coi là tỉ lệ 1:1.",
    });
  }
  const artboard = hasView
    ? {
        x: view[0],
        y: view[1],
        width: widthMm ?? view[2],
        height: heightMm ?? view[3],
        unit: widthMm != null ? "mm" : "file_unit",
      }
    : null;
  return { artboard, mmPerUserX, mmPerUserY, viewMinX: hasView ? view[0] : 0, viewMinY: hasView ? view[1] : 0 };
}

function shapeSubpaths(name: string, attrs: Attrs, matrix: Matrix, warnings: VectorWarning[]): Subpath[] | null {
  if (name === "path" && attrs.d) return parseSvgPath(attrs.d, matrix);
  if (name === "rect") {
    const x = num(attrs.x);
    const y = num(attrs.y);
    const w = num(attrs.width);
    const h = num(attrs.height);
    if (w <= 0 || h <= 0) return null;
    const corners = [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y],
    ].map(([px, py]) => {
      const [tx, ty] = apply(matrix, px, py);
      return { x: tx, y: ty };
    });
    return [{ points: corners, closed: true }];
  }
  if (name === "circle" || name === "ellipse") {
    const cx = num(attrs.cx);
    const cy = num(attrs.cy);
    const rx = name === "circle" ? num(attrs.r) : num(attrs.rx);
    const ry = name === "circle" ? num(attrs.r) : num(attrs.ry);
    if (rx <= 0 || ry <= 0) return null;
    const hw = Math.hypot(matrix[0] * rx, matrix[2] * ry);
    const hh = Math.hypot(matrix[1] * rx, matrix[3] * ry);
    const [tcx, tcy] = apply(matrix, cx, cy);
    const points: Pt[] = [];
    for (let i = 0; i <= 32; i += 1) {
      const t = (i / 32) * Math.PI * 2;
      const [px, py] = apply(matrix, cx + rx * Math.cos(t), cy + ry * Math.sin(t));
      points.push({ x: px, y: py });
    }
    points.push({ x: tcx - hw, y: tcy - hh }, { x: tcx + hw, y: tcy - hh }, { x: tcx - hw, y: tcy + hh }, { x: tcx + hw, y: tcy + hh });
    return [{ points, closed: true }];
  }
  if (name === "polygon" || name === "polyline") {
    const pairs = (attrs.points ?? "").trim().split(/[\s,]+/).map(Number);
    const points: Pt[] = [];
    for (let i = 0; i + 1 < pairs.length; i += 2) {
      if (!Number.isFinite(pairs[i]) || !Number.isFinite(pairs[i + 1])) continue;
      const [x, y] = apply(matrix, pairs[i], pairs[i + 1]);
      points.push({ x, y });
    }
    if (points.length < 2) return null;
    return [{ points, closed: name === "polygon" }];
  }
  if (name === "line") {
    const [x1, y1] = apply(matrix, num(attrs.x1), num(attrs.y1));
    const [x2, y2] = apply(matrix, num(attrs.x2), num(attrs.y2));
    return [{ points: [{ x: x1, y: y1 }, { x: x2, y: y2 }], closed: false }];
  }
  if (!["g", "svg"].includes(name)) {
    warnings.push({ code: "svg_element_skipped", message: `Bỏ thẻ <${name}>.` });
  }
  return null;
}

function num(value: string | undefined): number {
  const parsed = Number.parseFloat(value ?? "0");
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseLength(value: string | undefined): { n: number; unit: string } | null {
  if (!value) return null;
  const match = /^([+-]?(?:\d+\.?\d*|\.\d+))(mm|cm|in|pt|pc|px|%)?$/.exec(value.trim());
  if (!match) return null;
  return { n: Number(match[1]), unit: match[2] ?? "px" };
}

function lengthToMm(n: number, unit: string): number | null {
  switch (unit) {
    case "mm":
      return n;
    case "cm":
      return n * 10;
    case "in":
      return n * 25.4;
    case "pt":
      return (n * 25.4) / 72;
    case "pc":
      return (n * 25.4) / 6;
    default:
      return null;
  }
}

export function unionBBox(pieces: Array<{ bbox: { x: number; y: number; width: number; height: number } }>) {
  return bboxOf(
    pieces.flatMap((piece) => [
      { x: piece.bbox.x, y: piece.bbox.y },
      { x: piece.bbox.x + piece.bbox.width, y: piece.bbox.y + piece.bbox.height },
    ]),
  );
}
