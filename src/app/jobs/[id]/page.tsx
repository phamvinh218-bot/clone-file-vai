import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppError } from "@/domain/errors";
import { presentJob } from "@/jobs/present";
import { currentStaff } from "@/ui/current";
import { geometryPreviewSvg } from "@/ui/preview";
import { JobPoller } from "./poller";

export const dynamic = "force-dynamic";

const STAMP: Record<string, string> = {
  completed: "good",
  failed: "bad",
  dispatch_failed: "bad",
  manual_handoff: "hand",
  dispatched: "waiting",
  leased: "waiting",
  dispatch_pending: "waiting",
};

export default async function JobPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string; notice?: string }>;
}) {
  const { runtime, user } = await currentStaff();
  if (!user || !runtime.services || !runtime.store) redirect("/login");
  const { id } = await params;
  const query = await searchParams;
  let job;
  try {
    job = await runtime.services.owned(user.id, id);
  } catch (error) {
    if (error instanceof AppError && error.code === "not_found") notFound();
    throw error;
  }
  const assets = await runtime.store.listAssets(job.id);
  const view = presentJob(job, assets);
  const preview = geometryPreviewSvg(job.doc.parse.pieces);
  const stamp = STAMP[view.status] ?? "waiting";
  return (
    <main className="shell">
      <header className="mast">
        <div>
          <h1>{view.title}</h1>
          <p>Luật {view.specVersion}. Lề mới là 10 mm mỗi cạnh, không dùng 20 mm của mẫu NURSE cũ.</p>
        </div>
        <Link href="/jobs">Danh sách</Link>
      </header>
      {query.error ? <p className="error">Không gửi được: {query.error}</p> : null}
      <section className="panel">
        <p><span className={`stamp ${stamp}`}>{view.label}</span></p>
        <p>{view.note}</p>
        <JobPoller
          jobId={view.id}
          initial={{ status: view.status, label: view.label, note: view.note, complete: view.complete, failed: view.failed, pollAfterMs: view.pollAfterMs }}
        />
        <p className="muted">
          {view.printReady
            ? "Đã xác nhận đơn vị vật lý. File in chỉ xuất hiện sau khi bot tải artifact."
            : "Chưa đủ điều kiện in 1:1. Bản này là xem trước."}
          {view.complete ? "" : " Việc chưa được đánh dấu xong chỉ vì webhook trả về."}
        </p>
      </section>
      <div className="grid">
        <section className="panel">
          <h2>Hình học đã đọc</h2>
          <p className="muted">Nét này do máy tính từ vector. Không phải ảnh vải và không phải bản proof của bot.</p>
          <div className="preview" dangerouslySetInnerHTML={{ __html: preview }} />
          {view.artboard ? (
            <p className="muted">
              Khổ trang đọc được: {view.artboard.width.toFixed(1)} × {view.artboard.height.toFixed(1)} {view.artboard.unit}. Khổ này không phải biên cắt.
            </p>
          ) : null}
          <table>
            <thead>
              <tr><th>Mảnh</th><th>Hoa văn</th><th>Rộng</th><th>Cao</th><th>Lỗ</th></tr>
            </thead>
            <tbody>
              {view.pieces.map((piece) => (
                <tr key={piece.id}>
                  <td>{piece.label}</td>
                  <td>{piece.patternKey ?? "chưa gán"}</td>
                  <td>{piece.bbox.width.toFixed(2)}</td>
                  <td>{piece.bbox.height.toFixed(2)}</td>
                  <td>{piece.holeCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
        <section className="panel">
          <h2>Bố cục</h2>
          {view.layout ? (
            <>
              <p>{view.layout.mode === "single_sheet" ? "Một hoa văn: một tấm liên tục." : "Từ hai hoa văn: mỗi mảnh một tấm, theo thứ tự file."}</p>
              <p>Lề pixel: {view.layout.marginPx} px ({view.layout.marginMm.toFixed(3)} mm) mỗi cạnh, {view.layout.ppi} PPI.</p>
              <table>
                <thead><tr><th>Tấm</th><th>Px</th><th>mm</th></tr></thead>
                <tbody>
                  {view.layout.sheets.map((sheet) => (
                    <tr key={sheet.id}>
                      <td>{sheet.id}</td>
                      <td>{sheet.widthPx} × {sheet.heightPx}</td>
                      <td>{sheet.widthMm.toFixed(2)} × {sheet.heightMm.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <form method="post" action={`/api/jobs/${job.id}/patterns`}>
              <p>Gán một tên hoa văn cho từng mảnh. Trùng hết thì ra một tấm. Khác nhau thì tách tấm, kể cả khi một hoa văn lặp lại.</p>
              {view.pieces.map((piece) => (
                <div key={piece.id}>
                  <label htmlFor={`pattern-${piece.id}`}>{piece.label}</label>
                  <input id={`pattern-${piece.id}`} name={`pattern_${piece.id}`} type="text" required maxLength={40} />
                </div>
              ))}
              <p><button type="submit">Tính khổ</button></p>
            </form>
          )}
          {view.layout && (view.status === "ready" || view.status === "dispatch_failed" || view.status === "manual_handoff") ? (
            <div>
              <form method="post" action={`/api/jobs/${job.id}/dispatch`}>
                <p><button type="submit">Gửi webhook cho Grok Bot</button></p>
              </form>
              <form method="post" action={`/api/jobs/${job.id}/handoff`}>
                <p><button className="warn" type="submit">Bàn giao tay</button></p>
              </form>
              <p className="muted">Bàn giao tay không gọi bot và không đánh dấu xong. Dùng khi bot chưa với tới máy này.</p>
            </div>
          ) : null}
        </section>
      </div>
      <section className="panel">
        <h2>File nguồn</h2>
        <ul>
          {view.sources.map((file) => (
            <li key={file.id}>
              <a href={`/api/jobs/${job.id}/files/${file.id}`}>{file.filename}</a> — {file.role}, {file.byteSize} byte
            </li>
          ))}
        </ul>
      </section>
      <section className="panel">
        <h2>Artifact của bot</h2>
        {view.artifacts.length === 0 ? <p>Chưa có file bot trả về. Ứng dụng không tự vẽ ảnh vải.</p> : null}
        <ul>
          {view.artifacts.map((file) => (
            <li key={file.id}>
              <a href={`/api/jobs/${job.id}/files/${file.id}`}>{file.kind}: {file.filename}</a>
              {file.mediaType === "image/png" ? (
                <img alt={file.kind ?? "artifact"} src={`/api/jobs/${job.id}/files/${file.id}`} style={{ display: "block", maxWidth: "100%", marginTop: 8 }} />
              ) : null}
            </li>
          ))}
        </ul>
      </section>
      {view.warnings.length ? (
        <section className="panel">
          <h2>Cảnh báo</h2>
          <ul>{view.warnings.map((warning, index) => <li key={`${warning.code}-${index}`}>{warning.message}</li>)}</ul>
        </section>
      ) : null}
      {view.handoff ? (
        <section className="panel">
          <h2>Gói bàn giao tay</h2>
          <p className="error">Không phải kết quả bot.</p>
          <textarea readOnly value={JSON.stringify(view.handoff.packet, null, 2)} />
        </section>
      ) : null}
      {view.failure ? (
        <section className="panel">
          <h2>Lý do thất bại</h2>
          <p>{view.failure.code}: {view.failure.message}</p>
        </section>
      ) : null}
    </main>
  );
}
