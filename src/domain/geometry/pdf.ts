import { inflateRawSync, inflateSync } from "node:zlib";
import { AppError } from "@/domain/errors";
import { apply, IDENTITY, multiply, type Matrix } from "@/domain/geometry/matrix";
import { classifyPieces, type RawPiece, type VectorParse, type VectorWarning } from "@/domain/geometry/model";
import { type Pt, type Subpath } from "@/domain/geometry/path";
import { cubicExtrema } from "@/domain/geometry/bezier";

type PdfObj = { id: number; dict: string; stream: Buffer | null };

export function parsePdf(bytes: Buffer, format: "pdf" | "ai_pdf"): VectorParse {
  const head = bytes.subarray(0, 8).toString("latin1");
  if (!head.startsWith("%PDF")) {
    throw new AppError("invalid_pdf", "File không phải PDF.", 422);
  }
  const latin = bytes.toString("latin1");
  if (/\/Encrypt\b/.test(latin)) {
    throw new AppError("unsupported_pdf", "PDF được mã hóa. Hãy xuất PDF không khóa.", 422);
  }
  if (/\/JavaScript\b|\/JS\b|\/Launch\b|\/OpenAction\b|\/EmbeddedFile\b/.test(latin)) {
    throw new AppError("unsupported_pdf_active", "PDF có JavaScript, hành động mở, hoặc file nhúng. Hãy xuất lại PDF chỉ chứa nét vector.", 422);
  }
  const objects = extractObjects(bytes);
  const page = objects.find((obj) => /\/Type\s*\/Page\b/.test(obj.dict) && !/\/Type\s*\/Pages\b/.test(obj.dict));
  if (!page) {
    throw new AppError("unsupported_pdf_structure", "Không thấy trang PDF cổ điển. Hãy lưu lại dạng PDF 1.4 không nén object stream.", 422);
  }
  const media = readBox(page.dict, objects);
  const contentIds = readRefs(page.dict, "Contents");
  if (contentIds.length === 0) {
    throw new AppError("no_applique_pieces", "Trang PDF không có nội dung vector.", 422);
  }
  const chunks: Buffer[] = [];
  for (const id of contentIds) {
    const obj = objects.find((item) => item.id === id);
    if (!obj?.stream) throw new AppError("unsupported_pdf_structure", "Không đọc được content stream.", 422);
    chunks.push(obj.stream, Buffer.from("\n"));
  }
  const warnings: VectorWarning[] = [];
  const raw = parseContent(Buffer.concat(chunks), warnings);
  if (raw.textOps) {
    warnings.push({ code: "excluded_text", message: "Bỏ chữ trong PDF. Chữ thêu không phải mảnh applique." });
  }
  const ptToMm = 25.4 / 72;
  const flat = raw.pieces.flatMap((piece) => piece.subpaths.flatMap((sub) => sub.points));
  const maxY = flat.length ? Math.max(...flat.map((pt) => pt.y)) : 0;
  const scaled: RawPiece[] = raw.pieces.map((piece) => ({
    openContour: piece.openContour,
    subpaths: piece.subpaths.map((sub) => ({
      closed: sub.closed,
      points: sub.points.map((pt) => ({ x: pt.x * ptToMm, y: (maxY - pt.y) * ptToMm })),
    })),
  }));
  const classified = classifyPieces(scaled, warnings, { minClosedArea: 1, minOpenSpan: 8 });
  if (classified.length === 0) {
    throw new AppError("no_applique_pieces", "Không tìm thấy mảnh applique trong PDF. Khổ trang không được dùng làm kích thước cắt.", 422);
  }
  return {
    format,
    hasPhysicalUnit: true,
    unitName: "mm",
    artboard: media
      ? {
          x: media[0] * ptToMm,
          y: media[1] * ptToMm,
          width: (media[2] - media[0]) * ptToMm,
          height: (media[3] - media[1]) * ptToMm,
          unit: "mm",
        }
      : null,
    warnings,
    pieces: classified.map((piece, index) => ({
      ...piece,
      id: `piece-${index + 1}`,
      index: index + 1,
      label: `Mảnh ${index + 1}`,
    })),
  };
}

function extractObjects(bytes: Buffer): PdfObj[] {
  const s = bytes.toString("latin1");
  const out: PdfObj[] = [];
  let i = 0;
  while (i < s.length) {
    const match = /(\d+)\s+(\d+)\s+obj/.exec(s.slice(i));
    if (!match) break;
    const id = Number(match[1]);
    const headerAt = i + match.index;
    const cursor = headerAt + match[0].length;
    const streamWord = indexOfOutside(s, "stream", cursor);
    const endObj = s.indexOf("endobj", cursor);
    if (endObj < 0) break;
    if (streamWord >= 0 && streamWord < endObj) {
      const dict = s.slice(cursor, streamWord);
      let dataStart = streamWord + "stream".length;
      if (s.charCodeAt(dataStart) === 13 && s.charCodeAt(dataStart + 1) === 10) dataStart += 2;
      else if (s.charCodeAt(dataStart) === 10) dataStart += 1;
      const endStream = s.indexOf("endstream", dataStart);
      if (endStream < 0) throw new AppError("unsupported_pdf_structure", "Stream PDF thiếu endstream.", 422);
      const length = readLength(dict);
      const dataEnd = length != null ? dataStart + length : endStream;
      const stream = decodeStream(bytes.subarray(dataStart, Math.min(dataEnd, bytes.length)), dict);
      out.push({ id, dict, stream });
      i = s.indexOf("endobj", endStream);
      if (i < 0) break;
      i += "endobj".length;
      continue;
    }
    out.push({ id, dict: s.slice(cursor, endObj), stream: null });
    i = endObj + "endobj".length;
  }
  return out;
}

function indexOfOutside(s: string, word: string, from: number): number {
  return s.indexOf(word, from);
}

function readLength(dict: string): number | null {
  const match = /\/Length\s+(\d+)\b/.exec(dict);
  if (!match) return null;
  return Number(match[1]);
}

function decodeStream(slice: Buffer, dict: string): Buffer {
  if (/\/Predictor\s+([2-9]|1\d)/.test(dict)) {
    throw new AppError("unsupported_pdf_filter", "PDF dùng predictor. Hãy xuất lại PDF không nén ảnh dòng.", 422);
  }
  if (/\/Filter\s*\/FlateDecode|\/Filter\s*\[\s*\/FlateDecode/.test(dict)) {
    try {
      return inflateSync(slice);
    } catch {
      try {
        return inflateRawSync(slice);
      } catch {
        throw new AppError("unsupported_pdf_filter", "Không giải nén được FlateDecode.", 422);
      }
    }
  }
  if (/\/Filter\b/.test(dict)) {
    throw new AppError("unsupported_pdf_filter", "PDF dùng bộ lọc chưa hỗ trợ. Hãy xuất PDF thường hoặc SVG.", 422);
  }
  return Buffer.from(slice);
}

function readRefs(dict: string, key: string): number[] {
  const single = new RegExp(`\\/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  if (single && !dict.includes(`/${key} [`)) return [Number(single[1])];
  const array = new RegExp(`\\/${key}\\s*\\[([^\\]]+)\\]`).exec(dict);
  if (!array) return single ? [Number(single[1])] : [];
  const ids: number[] = [];
  const ref = /(\d+)\s+\d+\s+R/g;
  let match: RegExpExecArray | null;
  while ((match = ref.exec(array[1]))) ids.push(Number(match[1]));
  return ids;
}

function readBox(dict: string, objects: PdfObj[]): number[] | null {
  const inline = /\/MediaBox\s*\[\s*([^\]]+)\]/.exec(dict);
  if (inline) {
    const nums = inline[1].trim().split(/\s+/).map(Number);
    if (nums.length === 4 && nums.every((n) => Number.isFinite(n))) return nums;
  }
  const ref = /\/MediaBox\s+(\d+)\s+\d+\s+R/.exec(dict);
  if (!ref) return null;
  const obj = objects.find((item) => item.id === Number(ref[1]));
  if (!obj) return null;
  const nums = obj.dict.replace(/[\[\]]/g, " ").trim().split(/\s+/).map(Number).filter((n) => Number.isFinite(n));
  return nums.length >= 4 ? nums.slice(0, 4) : null;
}

type Token = { kind: "num"; value: number } | { kind: "word"; value: string };

function tokenize(content: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < content.length) {
    const ch = content[i];
    if (ch === "%") {
      while (i < content.length && content[i] !== "\n") i += 1;
      continue;
    }
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "(") {
      i += 1;
      let depth = 1;
      while (i < content.length && depth > 0) {
        if (content[i] === "\\") i += 2;
        else {
          if (content[i] === "(") depth += 1;
          if (content[i] === ")") depth -= 1;
          i += 1;
        }
      }
      continue;
    }
    if (ch === "<") {
      if (content[i + 1] === "<") {
        i += 2;
        continue;
      }
      const end = content.indexOf(">", i);
      i = end < 0 ? content.length : end + 1;
      continue;
    }
    if (ch === ">" || ch === "[" || ch === "]") {
      i += 1;
      continue;
    }
    if (ch === "/") {
      i += 1;
      while (i < content.length && /[A-Za-z0-9+_.-]/.test(content[i])) i += 1;
      continue;
    }
    const num = /^[+-]?(?:\d+\.\d+|\d+\.|\.\d+|\d+)/.exec(content.slice(i));
    if (num) {
      tokens.push({ kind: "num", value: Number(num[0]) });
      i += num[0].length;
      continue;
    }
    const word = /^[A-Za-z*'"']+/.exec(content.slice(i));
    if (word) {
      tokens.push({ kind: "word", value: word[0] });
      i += word[0].length;
      continue;
    }
    i += 1;
  }
  return tokens;
}

function parseContent(stream: Buffer, warnings: VectorWarning[]): { pieces: RawPiece[]; textOps: number } {
  const tokens = tokenize(stream.toString("latin1"));
  let ctm: Matrix = IDENTITY;
  const stack: Matrix[] = [];
  let textDepth = 0;
  let textOps = 0;
  let subpaths: Subpath[] = [];
  const pen: { current: Subpath | null } = { current: null };
  let cx = 0;
  let cy = 0;
  const pieces: RawPiece[] = [];
  const nums: number[] = [];

  function startSub(x: number, y: number) {
    const [tx, ty] = apply(ctm, x, y);
    pen.current = { points: [{ x: tx, y: ty }], closed: false };
    subpaths.push(pen.current);
    cx = x;
    cy = y;
  }
  function addUser(x: number, y: number) {
    const [tx, ty] = apply(ctm, x, y);
    if (!pen.current) startSub(x, y);
    else pen.current.points.push({ x: tx, y: ty });
    cx = x;
    cy = y;
  }
  function addDevice(points: Pt[]) {
    if (!pen.current) {
      pen.current = { points: [], closed: false };
      subpaths.push(pen.current);
    }
    pen.current.points.push(...points);
  }
  function paint(kind: "stroke" | "fill" | "both") {
    if (textDepth === 0 && subpaths.some((sub) => sub.points.length > 1)) {
      pieces.push({
        subpaths: subpaths.map((sub) => ({ points: sub.points, closed: sub.closed || kind !== "stroke" })),
        openContour: kind === "stroke" && subpaths.some((sub) => !sub.closed),
      });
    }
    subpaths = [];
    pen.current = null;
  }

  for (const token of tokens) {
    if (token.kind === "num") {
      nums.push(token.value);
      continue;
    }
    const op = token.value;
    const take = (count: number) => {
      const got = nums.splice(nums.length - count, count);
      return got.length === count ? got : [];
    };
    if (op === "q") {
      stack.push(ctm);
      nums.length = 0;
      continue;
    }
    if (op === "Q") {
      ctm = stack.pop() ?? IDENTITY;
      nums.length = 0;
      continue;
    }
    if (op === "cm") {
      const n = take(6);
      if (n.length === 6) {
        const m: Matrix = [n[0], n[1], n[2], n[3], n[4], n[5]];
        ctm = multiply(ctm, m);
      }
      continue;
    }
    if (op === "BT") {
      textDepth += 1;
      nums.length = 0;
      continue;
    }
    if (op === "ET") {
      textDepth = Math.max(0, textDepth - 1);
      nums.length = 0;
      continue;
    }
    if (op === "Tj" || op === "TJ" || op === "'" || op === '"') {
      textOps += 1;
      nums.length = 0;
      continue;
    }
    if (textDepth > 0) {
      nums.length = 0;
      continue;
    }
    if (op === "m") {
      const n = take(2);
      if (n.length === 2) startSub(n[0], n[1]);
      continue;
    }
    if (op === "l") {
      const n = take(2);
      if (n.length === 2) addUser(n[0], n[1]);
      continue;
    }
    if (op === "c") {
      const n = take(6);
      if (n.length === 6) {
        const start = { x: cx, y: cy };
        const p1 = { x: n[0], y: n[1] };
        const p2 = { x: n[2], y: n[3] };
        const end = { x: n[4], y: n[5] };
        const pts = cubicExtrema(start, p1, p2, end).map((pt) => {
          const [x, y] = apply(ctm, pt.x, pt.y);
          return { x, y };
        });
        addDevice(pts);
        cx = end.x;
        cy = end.y;
      }
      continue;
    }
    if (op === "re") {
      const n = take(4);
      if (n.length === 4) {
        const [x, y, w, h] = n;
        startSub(x, y);
        addUser(x + w, y);
        addUser(x + w, y + h);
        addUser(x, y + h);
        addUser(x, y);
        if (pen.current) pen.current.closed = true;
      }
      continue;
    }
    if (op === "h") {
      if (pen.current && pen.current.points.length) {
        pen.current.closed = true;
        pen.current.points.push(pen.current.points[0]);
      }
      nums.length = 0;
      continue;
    }
    if (op === "W" || op === "W*") {
      warnings.push({ code: "pdf_clip_ignored", message: "PDF có clip. Khung cắt không được dùng làm khổ mảnh; biên lấy theo nét vẽ." });
      nums.length = 0;
      continue;
    }
    if (op === "n") {
      subpaths = [];
      pen.current = null;
      nums.length = 0;
      continue;
    }
    if (op === "S" || op === "s") {
      if (op === "s" && pen.current) pen.current.closed = true;
      paint("stroke");
      continue;
    }
    if (op === "f" || op === "F" || op === "f*") {
      paint("fill");
      continue;
    }
    if (op === "B" || op === "B*" || op === "b" || op === "b*") {
      if ((op === "b" || op === "b*") && pen.current) pen.current.closed = true;
      paint("both");
      continue;
    }
    nums.length = 0;
  }
  return { pieces, textOps };
}
