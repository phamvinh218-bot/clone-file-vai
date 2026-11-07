import { handleLogout } from "@/http/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handleLogout(req);
}
