import { handleLogin, handleLogout } from "@/http/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export function POST(req: Request) {
  return handleLogin(req);
}

export function DELETE(req: Request) {
  return handleLogout(req);
}
