import { handleMcp } from "@/http/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function GET(req: Request) {
  return handleMcp(req);
}

export function POST(req: Request) {
  return handleMcp(req);
}

export function DELETE(req: Request) {
  return handleMcp(req);
}
