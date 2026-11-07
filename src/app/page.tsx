import Link from "next/link";
import { currentStaff } from "@/ui/current";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const { runtime, user } = await currentStaff();
  return (
    <main className="shell">
      <header className="mast">
        <div>
          <h1>Xưởng Vinh</h1>
          <p>Việc applique nội bộ. Ứng dụng giữ file và hình học; bot mới là nơi dựng mặt vải.</p>
        </div>
        <nav className="nav">
          {user ? <Link href="/jobs">Việc của tôi</Link> : <Link href="/login">Đăng nhập</Link>}
        </nav>
      </header>
      <section className="panel">
        <h2>Cổng thiết lập</h2>
        <p className="muted">
          Máy này chạy kho SQLite cục bộ. Chưa có dự án Vercel, chưa có tunnel, và chưa có lượt chạy bot thật.
          Webhook HTTP 200 chỉ nghĩa là bot đã bắt đầu, không phải việc đã xong.
        </p>
        <ul className="gates">
          {runtime.gates.map((gate) => (
            <li key={gate.name}>
              <div>
                <strong>{gate.name}</strong>
                <div className="muted">{gate.detail}</div>
              </div>
              <span className={gate.ok ? "ok" : "no"}>{gate.ok ? "sẵn sàng" : "chưa"}</span>
            </li>
          ))}
        </ul>
        {runtime.storeError ? <p className="error">{runtime.storeError}</p> : null}
      </section>
    </main>
  );
}
