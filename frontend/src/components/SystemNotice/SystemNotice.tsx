import type { SystemNotice as SystemNoticeValue } from "../../diagnostics/events";
import "./SystemNotice.css";

export default function SystemNotice({
  notice,
  onDismiss,
}: {
  notice: SystemNoticeValue;
  onDismiss: () => void;
}) {
  return (
    <aside className={`system-notice ${notice.kind}`} role="alert">
      <div>
        <strong>{notice.title}</strong>
        <p>{notice.message}</p>
      </div>
      <button type="button" onClick={onDismiss} aria-label="Dismiss notification">
        ×
      </button>
    </aside>
  );
}
