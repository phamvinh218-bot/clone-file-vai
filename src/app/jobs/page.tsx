import Link from "next/link";
import { redirect } from "next/navigation";
import { currentStaff } from "@/ui/current";

export const dynamic = "force-dynamic";

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ error?: string; notice?: string }> }) {
  const { runtime, user } = await currentStaff();
  if (!user || !runtime.services) redirect("/login");
  const query = await searchParams;
  const jobs = await runtime.services.listMine(user.id);
  return (
    <main className="shell">
      <header className="mast">
        <div>
          <h1>Việc của {user.email}</h1>
          <p>Mỗi người chỉ thấy việc của mình.</p>
        </div>
        <nav className="nav">
          <Link href="/jobs/new">Tạo việc</Link>
          <form method="post" action="/api/session">
            <input type="hidden" name="_method" value="delete" />
            <button className="secondary" type="submit" formAction="/api/logout">Thoát</button>
          </form>
        </nav>
      </header>
      {query.error ? <p className="error">Không thực hiện được: {query.error}</p> : null}
      <section className="panel">
        {jobs.length === 0 ? <p>Chưa có việc.</p> : null}
        <table>
          <thead>
            <tr><th>Tên</th><th>Trạng thái</th><th>In được</th></tr>
          </thead>
          <tbody>
            {jobs.map((job) => (
              <tr key={job.id}>
                <td><Link href={`/jobs/${job.id}`}>{job.doc.title}</Link></td>
                <td>{job.status}</td>
                <td>{job.doc.printReady ? "có, nếu bot trả file" : "xem trước"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
      <section className="panel">
        <h2>Thêm nhân viên</h2>
        <form method="post" action="/api/staff">
          <label htmlFor="staff-email">Email</label>
          <input id="staff-email" name="email" type="email" required />
          <label htmlFor="staff-password">Mật khẩu (ít nhất 12 ký tự)</label>
          <input id="staff-password" name="password" type="password" minLength={12} required />
          <p><button type="submit">Tạo tài khoản</button></p>
        </form>
      </section>
    </main>
  );
}
