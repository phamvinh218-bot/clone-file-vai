import { nextPollDelayMs } from "@/domain/poll";
import type { AssetRow } from "@/store/types";
import type { Job } from "@/jobs/service";

const LABELS: Record<string, string> = {
  needs_pattern: "Chờ gán hoa văn",
  ready: "Sẵn sàng gửi",
  dispatch_pending: "Đang gửi webhook…",
  dispatched: "Bot đã được gọi — việc chưa xong",
  dispatch_failed: "Webhook không khởi chạy",
  leased: "Bot đang giữ việc",
  manual_handoff: "Bàn giao tay — bot chưa chạy",
  completed: "Đã xong",
  failed: "Thất bại",
};

export type JobView = {
  id: string;
  title: string;
  status: string;
  label: string;
  note: string;
  complete: boolean;
  failed: boolean;
  poll: boolean;
  pollAfterMs: number | null;
  printReady: boolean;
  specVersion: string;
  unitName: string;
  hasPhysicalUnit: boolean;
  artboard: Job["doc"]["parse"]["artboard"];
  pieces: Array<{ id: string; index: number; label: string; patternKey: string | null; bbox: Job["doc"]["parse"]["pieces"][number]["bbox"]; openContour: boolean; holeCount: number }>;
  layout: Job["doc"]["layout"];
  warnings: Job["doc"]["warnings"];
  dispatchHttpStatus: number | null;
  dispatchError: Job["doc"]["dispatchError"];
  failure: Job["doc"]["failure"];
  handoff: Job["doc"]["handoff"];
  artifacts: Array<{ id: string; kind: string | null; filename: string; mediaType: string; byteSize: number }>;
  sources: Array<{ id: string; role: string; filename: string; mediaType: string; byteSize: number }>;
};

export function presentJob(job: Job, assets: AssetRow[]): JobView {
  const complete = job.status === "completed";
  const failed = job.status === "failed";
  if (complete && failed) throw new Error("A job cannot be both complete and failed");
  const poll = job.status === "dispatch_pending" || job.status === "dispatched" || job.status === "leased";
  return {
    id: job.id,
    title: job.doc.title,
    status: job.status,
    label: LABELS[job.status] ?? job.status,
    note: noteFor(job.status),
    complete,
    failed,
    poll,
    pollAfterMs: nextPollDelayMs(null, true, job.status),
    printReady: job.doc.printReady,
    specVersion: job.doc.specVersion,
    unitName: job.doc.parse.unitName,
    hasPhysicalUnit: job.doc.parse.hasPhysicalUnit,
    artboard: job.doc.parse.artboard,
    pieces: job.doc.parse.pieces.map((piece) => ({
      id: piece.id,
      index: piece.index,
      label: piece.label,
      patternKey: job.doc.patternByPieceId[piece.id] ?? null,
      bbox: piece.bbox,
      openContour: piece.openContour,
      holeCount: piece.holes.length,
    })),
    layout: job.doc.layout,
    warnings: job.doc.warnings,
    dispatchHttpStatus: job.doc.dispatch?.httpStatus ?? null,
    dispatchError: job.doc.dispatchError,
    failure: job.doc.failure,
    handoff: job.doc.handoff,
    artifacts: assets
      .filter((asset) => asset.role === "artifact")
      .map((asset) => ({ id: asset.id, kind: asset.kind, filename: asset.filename, mediaType: asset.mediaType, byteSize: asset.byteSize })),
    sources: assets
      .filter((asset) => asset.role !== "artifact")
      .map((asset) => ({ id: asset.id, role: asset.role, filename: asset.filename, mediaType: asset.mediaType, byteSize: asset.byteSize })),
  };
}

function noteFor(status: string): string {
  switch (status) {
    case "dispatched":
      return "HTTP 200 từ webhook chỉ có nghĩa là Grok Bot đã nhận và bắt đầu một lượt chạy. Việc này chưa xong.";
    case "dispatch_pending":
      return "Đang chờ máy chủ webhook trả lời. Chưa có kết quả từ bot.";
    case "leased":
      return "Bot đã nhận việc qua MCP. Ảnh vải chỉ xuất hiện sau khi bot tải artifact lên.";
    case "manual_handoff":
      return "Đây là gói bàn giao tay để bạn tự đưa cho bot. Không có lượt chạy nào được ghi nhận, và việc chưa xong.";
    case "failed":
      return "Việc thất bại. Trạng thái này không được đổi thành hoàn tất.";
    case "completed":
      return "Bot đã gọi complete sau khi đủ ba file. Ảnh dưới đây là artifact bot tải lên, không phải ảnh ứng dụng tự vẽ.";
    case "dispatch_failed":
      return "Webhook không được chấp nhận. Việc chưa chuyển cho bot.";
    case "ready":
      return "Bố cục đã tính theo luật 10 mm. Gửi webhook chỉ khi bot gọi được địa chỉ công khai.";
    default:
      return "Mỗi mảnh applique cần một tên hoa văn. Một hoa văn dùng chung cho mọi mảnh thì ra một tấm; từ hai hoa văn trở lên thì mỗi mảnh một tấm, kể cả hoa văn lặp.";
  }
}
