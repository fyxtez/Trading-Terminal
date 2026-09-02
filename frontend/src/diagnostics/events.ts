export const SYSTEM_NOTICE_EVENT = "fyxtez:system-notice";

export type SystemNotice = {
  id: string;
  kind: "warning" | "error";
  title: string;
  message: string;
  occurredAt: number;
};

export function publishSystemNotice(
  notice: Omit<SystemNotice, "id" | "occurredAt"> & {
    id?: string;
    occurredAt?: number;
  },
): void {
  window.dispatchEvent(
    new CustomEvent<SystemNotice>(SYSTEM_NOTICE_EVENT, {
      detail: {
        ...notice,
        id: notice.id ?? crypto.randomUUID(),
        occurredAt: notice.occurredAt ?? Date.now(),
      },
    }),
  );
}
