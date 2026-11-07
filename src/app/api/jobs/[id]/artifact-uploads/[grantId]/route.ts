import { handleArtifactUpload } from "@/http/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, ctx: { params: Promise<{ id: string; grantId: string }> }) {
  const { id, grantId } = await ctx.params;
  return handleArtifactUpload(req, id, grantId);
}
