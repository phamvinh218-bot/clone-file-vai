import { AppError } from "@/domain/errors";
import { isArtifactKind, LIMITS, type ArtifactKind } from "@/domain/limits";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function sanitizeFilename(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? "file";
  const cleaned = base.replace(/[^\w.\- ()]+/g, "_").replace(/^\.+/, "").slice(0, 80);
  return cleaned || "file";
}

export function validateMockup(filename: string, bytes: Buffer): { filename: string; mediaType: string } {
  if (bytes.length > LIMITS.mockupBytes) {
    throw new AppError("file_too_large", "Ảnh mockup vượt quá 8 MB.", 413);
  }
  if (bytes.length < 32) throw new AppError("invalid_mockup", "Ảnh mockup quá nhỏ hoặc rỗng.", 422);
  const safe = sanitizeFilename(filename);
  if (bytes.subarray(0, 8).equals(PNG)) return { filename: safe, mediaType: "image/png" };
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return { filename: safe, mediaType: "image/jpeg" };
  if (bytes.subarray(0, 4).toString("latin1") === "RIFF" && bytes.subarray(8, 12).toString("latin1") === "WEBP") {
    return { filename: safe, mediaType: "image/webp" };
  }
  throw new AppError("invalid_mockup", "Mockup phải là PNG, JPEG, hoặc WEBP đúng chữ ký file.", 422);
}

export function validateVectorUpload(filename: string, bytes: Buffer): { filename: string; mediaType: string } {
  if (bytes.length > LIMITS.vectorBytes) throw new AppError("file_too_large", "File vector vượt quá 8 MB.", 413);
  if (bytes.length < 8) throw new AppError("invalid_vector", "File vector quá nhỏ.", 422);
  const safe = sanitizeFilename(filename);
  const lower = safe.toLowerCase();
  if (lower.endsWith(".svg")) {
    const text = bytes.toString("utf8").replace(/^\uFEFF/, "").trimStart();
    if (!text.startsWith("<") || !/<svg[\s>]/i.test(text)) {
      throw new AppError("invalid_vector", "File .svg không chứa phần tử svg.", 422);
    }
    return { filename: safe, mediaType: "image/svg+xml" };
  }
  if (lower.endsWith(".pdf") || lower.endsWith(".ai")) {
    if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF") && lower.endsWith(".pdf")) {
      throw new AppError("invalid_vector", "File .pdf không bắt đầu bằng %PDF.", 422);
    }
    return { filename: safe, mediaType: lower.endsWith(".ai") ? "application/illustrator" : "application/pdf" };
  }
  throw new AppError("unsupported_vector", "Chỉ nhận SVG, PDF, hoặc AI.", 422);
}

export function validateArtifact(kind: string, bytes: Buffer): { kind: ArtifactKind; mediaType: string } {
  if (!isArtifactKind(kind)) throw new AppError("invalid_artifact", "Loại artifact không được phép.", 422);
  if (bytes.length > LIMITS.artifactBytes) throw new AppError("file_too_large", "Artifact vượt quá 32 MB.", 413);
  if (bytes.length < 32) throw new AppError("invalid_artifact", "Artifact quá nhỏ.", 422);
  if (kind === "print_pdf") {
    if (!bytes.subarray(0, 5).toString("latin1").startsWith("%PDF")) {
      throw new AppError("invalid_artifact", "print_pdf phải là PDF.", 422);
    }
    return { kind, mediaType: "application/pdf" };
  }
  if (!bytes.subarray(0, 8).equals(PNG)) {
    throw new AppError("invalid_artifact", `${kind} phải là PNG.`, 422);
  }
  return { kind, mediaType: "image/png" };
}
