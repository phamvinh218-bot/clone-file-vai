import { AppError } from "@/domain/errors";
import { parsePdf } from "@/domain/geometry/pdf";
import { parseSvg } from "@/domain/geometry/svg";
import type { VectorParse } from "@/domain/geometry/model";

export async function parseVectorFile(filename: string, bytes: Buffer): Promise<VectorParse> {
  const lower = filename.trim().toLowerCase();
  const head = bytes.subarray(0, Math.min(bytes.length, 16)).toString("latin1");
  if (lower.endsWith(".ai")) {
    if (head.startsWith("%PDF")) return parsePdf(bytes, "ai_pdf");
    throw new AppError(
      "unsupported_ai",
      "File AI này không nhúng PDF. Hãy tự lưu bản PDF hoặc SVG rồi tải lên. Ứng dụng không tự chuyển file Illustrator.",
      422,
    );
  }
  if (lower.endsWith(".svg")) return parseSvg(bytes);
  if (lower.endsWith(".pdf") || head.startsWith("%PDF")) return parsePdf(bytes, "pdf");
  throw new AppError("unsupported_vector", "Chỉ nhận SVG, PDF, hoặc AI dạng PDF.", 422);
}

export type { VectorParse, VectorPiece, VectorWarning } from "@/domain/geometry/model";
