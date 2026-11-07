import Link from "next/link";

export const dynamic = "force-dynamic";

const TEXT: Record<string, string> = {
  invalid_login: "Sai email hoặc mật khẩu.",
  not_configured: "Máy chủ chưa có SESSION_SECRET hoặc kho dữ liệu.",
  origin_opaque:
    "Trình duyệt gửi Origin rỗng, nên đăng nhập bị từ chối. Hãy tải lại trang này và thử lại. Đừng gửi lại từ /api/session.",
  origin_invalid: "Nguồn trang không hợp lệ. Hãy tải lại trang này và thử lại.",
  csrf: "Yêu cầu đến từ trang khác. Hãy đăng nhập từ chính trang này.",
  internal: "Có lỗi máy chủ. Hãy tải lại trang đăng nhập. Nếu vẫn lỗi, chụp dòng lỗi trong terminal, không chụp mật khẩu hay file .env.",
};

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const query = await searchParams;
  return (
    <main className="shell">
      <header className="mast">
        <div>
          <h1>Đăng nhập</h1>
          <p>Tài khoản nhân viên, tách khỏi token của bot.</p>
        </div>
        <Link href="/">Trang thiết lập</Link>
      </header>
      <form className="panel" method="post" action="/api/session">
        {query.error ? <p className="error">{TEXT[query.error] ?? "Không đăng nhập được."}</p> : null}
        <label htmlFor="email">Email</label>
        <input id="email" name="email" type="email" autoComplete="username" required />
        <label htmlFor="password">Mật khẩu</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required />
        <p><button type="submit">Vào xưởng</button></p>
      </form>
    </main>
  );
}
