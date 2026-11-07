import { describe, expect, it } from "vitest";
import { newJobRetryQuery } from "@/http/handlers";

describe("create job retry", () => {
  it("keeps the title and scale confirmation and does not expose a raw parser code as the only message", () => {
    const query = new URLSearchParams(newJobRetryQuery("unsupported_pdf_filter", "NURSE\n#1", true));
    expect(query.get("error")).toBe("unsupported_pdf_filter");
    expect(query.get("title")).toBe("NURSE#1");
    expect(query.get("scale")).toBe("1");
    expect(query.get("title")).not.toContain("\n");
  });
});
