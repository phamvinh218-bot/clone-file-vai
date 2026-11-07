import Link from "next/link";
import { redirect } from "next/navigation";
import { currentStaff } from "@/ui/current";

export const dynamic = "force-dynamic";

const TEXT: Record<string, string> = {
  unsupported_ai: "File AI không nhúng PDF. Hãy tự lưu PDF hoặc SVG rồi tải lại.",
  invalid_mockup: "Mockup phải là PNG, JPEG hoặc WEBP đúng chữ ký.",
  invalid_vector: "Vector không đúng định dạng.",
  svg_active_content: "SVG có script hoặc nội dung nhúng nên bị từ chối.",
  no_applique_pieces: "Không thấy mảnh applique. Chữ thêu không được tính.",
  file_too_large: "File vượt quá giới hạn.",
  missing_file: "Cần cả ảnh mockup và file vector.",
};

export default async function NewJobPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { user } = await currentStaff();
  if (!user) redirect("/login");
  const query = await searchParams;
  return (
    <main className="shell">
      <header className="mast">
        <div>
          <h1>Tạo việc</h1>
          <p>Ảnh mockup để bot xem màu. Vector để máy đọc biên cắt.</p>
        </div>
        <Link href="/jobs">Danh sách</Link>
      </header>
      <form className="panel" method="post" action="/api/jobs" encType="multipart/form-data">
        {query.error ? <p className="error">{TEXT[query.error] ?? query.error}</p> : null}
        <label htmlFor="title">Tên việc</label>
        <input id="title" name="title" type="text" maxLength={120} required placeholder="Ví dụ: NURSE kẻ sọc" />
        <label htmlFor="mockup">Ảnh mockup</label>
        <input id="mockup" name="mockup" type="file" accept="image/png,image/jpeg,image/webp" required />
        <label htmlFor="vector">Vector laser (SVG, PDF, hoặc AI dạng PDF)</label>
        <input id="vector" name="vector" type="file" accept=".svg,.pdf,.ai,image/svg+xml,application/pdf" required />
        <label>
          <input name="scaleConfirmed" type="checkbox" /> File này là tỉ lệ danh nghĩa 1:1 và có đơn vị mm/pt
        </label>
        <p className="muted">Nếu file chỉ có pixel, việc vẫn được nhận nhưng chỉ là bản xem trước, không phải file in.</p>
        <button type="submit">Đọc hình học</button>
      </form>
    </main>
  );
}
