import { describe, expect, it } from "vitest";
import { AppError } from "@/domain/errors";
import { validateArtifact, validateMockup, validateVectorUpload } from "@/domain/files";
import { parseVectorFile } from "@/domain/geometry/parse";
import { TINY_PNG } from "@/test/fixture";

describe("upload validation", () => {
  it("rejects renamed executables, active SVG, and non-PDF Illustrator files", async () => {
    expect(() => validateMockup("photo.png", Buffer.from("MZ not a png".padEnd(40, " ")))).toThrow(AppError);
    expect(() => validateMockup("big.png", Buffer.alloc(8 * 1024 * 1024 + 1, 1))).toThrow(AppError);
    expect(validateMockup("ok.png", TINY_PNG).mediaType).toBe("image/png");
    const svg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40"><rect width="20" height="20"/></svg>`,
    );
    expect(validateVectorUpload("cut.svg", svg).mediaType).toBe("image/svg+xml");
    expect(() =>
      validateVectorUpload(
        "bad.svg",
        Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40"><script>alert(1)</script><rect width="20" height="20"/></svg>`),
      ),
    ).not.toThrow();
    await expect(parseVectorFile("bad.svg", Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="40mm" height="40mm" viewBox="0 0 40 40"><script>alert(1)</script><rect width="20" height="20"/></svg>`))).rejects.toThrow(
      /script/,
    );
    await expect(parseVectorFile("legacy.ai", Buffer.from("%!PS-Adobe-3.0\n%%Creator: Adobe Illustrator\n"))).rejects.toThrow(/PDF hoặc SVG/);
    expect(() => validateArtifact("print_png", Buffer.from("%PDF-1.4\n" + " ".repeat(40)))).toThrow(AppError);
    expect(() => validateArtifact("print_pdf", TINY_PNG)).toThrow(AppError);
  });
});
