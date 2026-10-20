// ---------------------------------------------------------------------------
// NOTIFICATION BELL (§1) — the UI end of the in-app notification service
// (api.records.listNotifications, derived server-side from records the caller
// can already see; read/dismiss state persisted per account, migration 0021).
// Used by BOTH portal shells: staff (Portal) and operator (Operate) — the
// service scopes per identity, so each shell shows only its own events.
//
// This file only wires the data layer to the presentational
// NotificationBellView (which owns the popover and is tested without a backend).
// ---------------------------------------------------------------------------

import {
  NotificationBellView,
  type BellNotification,
} from "@/components/NotificationBellView";
import { useMutation, useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";

export interface NotificationBellProps {
  /** Which side of the bell the panel opens on (sidebar bells open upward). */
  side?: "top" | "bottom";
  align?: "start" | "end";
}

export default function NotificationBell({
  side,
  align,
}: NotificationBellProps = {}) {
  const notifQ = useQuery(api.records.listNotifications);
  const markRead = useMutation(api.records.markNotificationRead);
  const markAllRead = useMutation(api.records.markAllNotificationsRead);
  const dismiss = useMutation(api.records.dismissNotification);
  const dismissAll = useMutation(api.records.dismissAllNotifications);

  return (
    <NotificationBellView
      notifs={notifQ as ReadonlyArray<BellNotification> | undefined}
      onMarkRead={(id) => void markRead(id)}
      onMarkAllRead={() => void markAllRead()}
      onDismiss={(id) => void dismiss(id)}
      onDismissAll={() => void dismissAll()}
      side={side}
      align={align}
    />
  );
}
