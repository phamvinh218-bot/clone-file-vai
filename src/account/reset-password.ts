import { AppError } from "@/domain/errors";
import { LIMITS } from "@/domain/limits";
import { hashPassword } from "@/domain/password";
import type { Store } from "@/store/types";

export async function resetStoredPassword(store: Store, email: string, password: string): Promise<void> {
  const normalized = email.trim().toLowerCase();
  if (!normalized.includes("@")) throw new AppError("invalid_staff", "Email không hợp lệ.", 422);
  if (password.length < LIMITS.passwordMin || password !== password.trim()) {
    throw new AppError("invalid_staff", "Mật khẩu cần ít nhất 12 ký tự và không có khoảng trắng ở đầu hoặc cuối.", 422);
  }
  const updated = await store.replacePasswordHash(normalized, hashPassword(password));
  if (!updated) throw new AppError("not_found", "Không có tài khoản nhân viên với email đó.", 404);
}
