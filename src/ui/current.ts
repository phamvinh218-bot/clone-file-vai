import { cookies } from "next/headers";
import { readSession, SESSION_COOKIE } from "@/domain/session";
import { getRequestRuntime, type Runtime } from "@/server/runtime";

export async function currentStaff(): Promise<{
  runtime: Runtime;
  user: { id: string; email: string } | null;
}> {
  const runtime = await getRequestRuntime();
  if (!runtime.config.sessionSecret || !runtime.store) return { runtime, user: null };
  const jar = await cookies();
  const session = readSession(runtime.config.sessionSecret, jar.get(SESSION_COOKIE)?.value, Date.now());
  if (!session) return { runtime, user: null };
  const user = await runtime.store.getUser(session.uid);
  return { runtime, user: user ? { id: user.id, email: user.email } : null };
}
