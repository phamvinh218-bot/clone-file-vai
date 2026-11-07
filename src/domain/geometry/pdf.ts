import { getDocument, OPS } from "pdfjs-dist/legacy/build/pdf.mjs";
import { AppError } from "@/domain/errors";
import { cubicExtrema } from "@/domain/geometry/bezier";
import { apply, IDENTITY, multiply, type Matrix } from "@/domain/geometry/matrix";
import { classifyPieces, type RawPiece, type VectorParse, type VectorWarning } from "@/domain/geometry/model";
import type { Pt, Subpath } from "@/domain/geometry/path";

/** Filters PDF.js decodes for content streams. Image-only filters are recognized so they do not hide real paths. */
export const PDF_CONTENT_FILTERS = ["FlateDecode", "LZWDecode", "ASCII85Decode", "ASCIIHexDecode", "RunLengthDecode"] as const;
const IMAGE_FILTERS = ["DCTDecode", "CCITTFaxDecode", "JBIG2Decode", "JPXDecode"];
const KNOWN_FILTERS = new Set<string>([...PDF_CONTENT_FILTERS, ...IMAGE_FILTERS]);

const PAINT = new Set<number>([
  OPS.stroke,
  OPS.closeStroke,
  OPS.fill,
  OPS.eoFill,
  OPS.fillStroke,
  OPS.eoFillStroke,
  OPS.closeFillStroke,
  OPS.closeEOFillStroke,
]);

const PT_TO_MM = 25.4 / 72;
const MAX_PAGES = 5;

export async function parsePdf(bytes: Buffer, format: "pdf" | "ai_pdf"): Promise<VectorParse> {
  if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
    throw new AppError("invalid_pdf", "File không phải PDF.", 422);
  }
  const latin = bytes.toString("latin1");
  if (/\/Encrypt\b/.test(latin)) {
    throw new AppError("unsupported_pdf", "PDF được khóa. Hãy xuất bản không mật khẩu. Khổ trang không được dùng làm kích thước cắt.", 422);
  }
  if (/\/JavaScript\b|\/JS\b|\/Launch\b|\/OpenAction\b|\/EmbeddedFile\b/.test(latin)) {
    throw new AppError("unsupported_pdf_active", "PDF có JavaScript, hành động mở, hoặc file nhúng. Hãy xuất lại PDF chỉ chứa nét vector.", 422);
  }

  const task = getDocument({
    data: new Uint8Array(bytes),
    disableWorker: true,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  } as Parameters<typeof getDocument>[0]);
  let pdf: Awaited<typeof task.promise>;
  try {
    pdf = await task.promise;
  } catch (error) {
    if (error instanceof AppError) throw error;
    const unknown = unknownFilters(bytes);
    if (unknown.length > 0) throw unsupportedFilter(unknown[0]);
    throw mapOpenError(error);
  }

  try {
    const warnings: VectorWarning[] = [];
    if (pdf.numPages > MAX_PAGES) {
      warnings.push({
        code: "pdf_page_limit",
        message: `Chỉ đọc ${MAX_PAGES} trang đầu. Khổ trang không được dùng làm kích thước cắt.`,
      });
    }
    const pageCount = Math.min(pdf.numPages, MAX_PAGES);
    const raw: RawPiece[] = [];
    let sawText = false;
    let artboard: VectorParse["artboard"] = null;
    for (let number = 1; number <= pageCount; number += 1) {
      const page = await pdf.getPage(number);
      if (!artboard) artboard = artboardFromView(page.view);
      let operators;
      try {
        operators = await page.getOperatorList();
      } catch (error) {
        if (error instanceof AppError) throw error;
        const unknown = unknownFilters(bytes);
        if (unknown.length > 0) throw unsupportedFilter(unknown[0]);
        throw mapOpenError(error);
      }
      const found = collectPieces(operators.fnArray, operators.argsArray);
      sawText = sawText || found.sawText;
      raw.push(...found.pieces);
    }
    if (sawText) {
      warnings.push({ code: "excluded_text", message: "Bỏ chữ trong PDF. Chữ thêu không phải mảnh applique." });
    }
    if (raw.length === 0) throw noVectorGeometry(bytes);
    const scaled = flipAndScale(raw);
    const classified = classifyPieces(scaled, warnings, { minClosedArea: 1, minOpenSpan: 8 });
    if (classified.length === 0) throw noVectorGeometry(bytes);
    return {
      format,
      hasPhysicalUnit: true,
      unitName: "mm",
      artboard,
      warnings,
      pieces: classified.map((piece, index) => ({
        ...piece,
        id: `piece-${index + 1}`,
        index: index + 1,
        label: `Mảnh ${index + 1}`,
      })),
    };
  } finally {
    await pdf.destroy();
  }
}

function artboardFromView(view: number[]): VectorParse["artboard"] {
  const [x1, y1, x2, y2] = view;
  return {
    x: x1 * PT_TO_MM,
    y: y1 * PT_TO_MM,
    width: (x2 - x1) * PT_TO_MM,
    height: (y2 - y1) * PT_TO_MM,
    unit: "mm",
  };
}

function collectPieces(fnArray: number[], argsArray: unknown[]): { pieces: RawPiece[]; sawText: boolean } {
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let pending: Subpath[] = [];
  let sawText = false;
  const pieces: RawPiece[] = [];
  for (let index = 0; index < fnArray.length; index += 1) {
    const fn = fnArray[index];
    const args = argsArray[index];
    if (fn === OPS.save) {
      stack.push(ctm);
      continue;
    }
    if (fn === OPS.restore) {
      ctm = stack.pop() ?? IDENTITY;
      continue;
    }
    if (fn === OPS.transform && Array.isArray(args) && args.length >= 6) {
      const matrix = args.slice(0, 6).map(Number) as Matrix;
      if (matrix.every((value) => Number.isFinite(value))) ctm = multiply(ctm, matrix);
      continue;
    }
    if (fn === OPS.beginText || fn === OPS.showText || fn === OPS.showSpacedText || fn === OPS.nextLineShowText || fn === OPS.nextLineSetSpacingShowText) {
      sawText = true;
      continue;
    }
    if (fn === OPS.constructPath && Array.isArray(args)) {
      const pathOps = args[0] as number[];
      const coords = args[1] as number[];
      pending.push(...pathSubpaths(pathOps, coords, ctm));
      continue;
    }
    if (fn === OPS.endPath) {
      pending = [];
      continue;
    }
    if (PAINT.has(fn)) {
      if (fn === OPS.closeStroke || fn === OPS.closeFillStroke || fn === OPS.closeEOFillStroke) {
        for (const subpath of pending) subpath.closed = true;
      }
      if (pending.some((subpath) => subpath.points.length > 1)) {
        const strokeOnly = fn === OPS.stroke || fn === OPS.closeStroke;
        pieces.push({
          subpaths: pending,
          openContour: strokeOnly && pending.some((subpath) => !subpath.closed),
        });
      }
      pending = [];
    }
  }
  return { pieces, sawText };
}

function pathSubpaths(pathOps: number[], coords: number[], ctm: Matrix): Subpath[] {
  const subs: Subpath[] = [];
  const pen: { current: Subpath | null } = { current: null };
  let cx = 0;
  let cy = 0;
  let cursor = 0;
  const take = (count: number) => {
    const values = coords.slice(cursor, cursor + count).map(Number);
    if (values.length < count || values.some((value) => !Number.isFinite(value))) {
      throw new AppError("unsupported_pdf_structure", "Nét PDF không đủ tọa độ. Khổ trang không được dùng làm kích thước cắt.", 422);
    }
    cursor += count;
    return values;
  };
  const push = (points: Pt[], closed: boolean) => {
    pen.current = { points: points.map((point) => transformPoint(ctm, point)), closed };
    subs.push(pen.current);
  };
  for (const op of pathOps) {
    if (op === OPS.moveTo) {
      const [x, y] = take(2);
      cx = x;
      cy = y;
      push([{ x, y }], false);
    } else if (op === OPS.lineTo) {
      const [x, y] = take(2);
      const dest = transformPoint(ctm, { x, y });
      if (!pen.current) push([{ x: cx, y: cy }], false);
      pen.current?.points.push(dest);
      cx = x;
      cy = y;
    } else if (op === OPS.curveTo || op === OPS.curveTo2 || op === OPS.curveTo3) {
      const start = { x: cx, y: cy };
      let c1 = start;
      let c2 = start;
      let end = start;
      if (op === OPS.curveTo) {
        const [c1x, c1y, c2x, c2y, ex, ey] = take(6);
        c1 = { x: c1x, y: c1y };
        c2 = { x: c2x, y: c2y };
        end = { x: ex, y: ey };
      } else if (op === OPS.curveTo2) {
        const [c2x, c2y, ex, ey] = take(4);
        c1 = start;
        c2 = { x: c2x, y: c2y };
        end = { x: ex, y: ey };
      } else {
        const [c1x, c1y, ex, ey] = take(4);
        end = { x: ex, y: ey };
        c1 = { x: c1x, y: c1y };
        c2 = end;
      }
      const extrema = cubicExtrema(transformPoint(ctm, start), transformPoint(ctm, c1), transformPoint(ctm, c2), transformPoint(ctm, end));
      if (!pen.current) push([start], false);
      for (const point of extrema) pen.current?.points.push(point);
      cx = end.x;
      cy = end.y;
    } else if (op === OPS.rectangle) {
      const [x, y, w, h] = take(4);
      push(
        [
          { x, y },
          { x: x + w, y },
          { x: x + w, y: y + h },
          { x, y: y + h },
          { x, y },
        ],
        true,
      );
      cx = x;
      cy = y;
    } else if (op === OPS.closePath) {
      if (pen.current) pen.current.closed = true;
    } else {
      throw new AppError("unsupported_pdf_structure", "Gặp nét PDF chưa hỗ trợ. Khổ trang không được dùng làm kích thước cắt.", 422);
    }
  }
  return subs.filter((subpath) => subpath.points.length > 0);
}

function transformPoint(matrix: Matrix, point: Pt): Pt {
  const [x, y] = apply(matrix, point.x, point.y);
  return { x, y };
}

function flipAndScale(pieces: RawPiece[]): RawPiece[] {
  const points = pieces.flatMap((piece) => piece.subpaths.flatMap((subpath) => subpath.points));
  const maxY = Math.max(...points.map((point) => point.y));
  return pieces.map((piece) => ({
    openContour: piece.openContour,
    subpaths: piece.subpaths.map((subpath) => ({
      closed: subpath.closed,
      points: subpath.points.map((point) => ({ x: point.x * PT_TO_MM, y: (maxY - point.y) * PT_TO_MM })),
    })),
  }));
}

function noVectorGeometry(bytes: Buffer): AppError {
  const unknown = unknownFilters(bytes);
  if (unknown.length > 0) return unsupportedFilter(unknown[0]);
  return new AppError("no_applique_pieces", "Không tìm thấy mảnh applique trong PDF. Khổ trang không được dùng làm kích thước cắt.", 422);
}

function unknownFilters(bytes: Buffer): string[] {
  const found = new Set<string>();
  const text = bytes.toString("latin1");
  const named = /\/([A-Za-z][A-Za-z0-9]{1,39})\b/g;
  let match: RegExpExecArray | null;
  while ((match = named.exec(text))) {
    if (match[1].endsWith("Decode") || match[1] === "Crypt") found.add(match[1]);
  }
  return [...found].filter((name) => !KNOWN_FILTERS.has(name));
}

function unsupportedFilter(name: string): AppError {
  const safe = /^[A-Za-z0-9]{1,40}$/.test(name) ? name : "không rõ";
  return new AppError(
    "unsupported_pdf_filter",
    `File PDF/AI dùng bộ lọc "${safe}" chưa được nhận. Lỗi này không chứng tỏ file hỏng. Khổ trang không được dùng làm kích thước cắt. Hãy gửi đúng file này, hoặc tạm lưu PDF 1.4 thường hay SVG.`,
    422,
  );
}

function mapOpenError(error: unknown): AppError {
  const name = error instanceof Error ? error.name : "";
  if (name === "PasswordException") {
    return new AppError("unsupported_pdf", "PDF được khóa. Hãy xuất bản không mật khẩu. Khổ trang không được dùng làm kích thước cắt.", 422);
  }
  if (error instanceof Error && /filter|flate|decode|stream/i.test(error.message)) return unsupportedFilter("không rõ");
  return new AppError("unsupported_pdf_structure", "Không đọc được cấu trúc PDF. Khổ trang không được dùng làm kích thước cắt.", 422);
}
