// ---------------------------------------------------------------------------
// NOTIFICATION BELL (§1) — the UI end of the minimal in-app notification
// service (api.records.listNotifications, derived server-side from records
// the caller can already see). Used by BOTH portal shells: staff (Portal)
// and operator (Operate) — the service scopes per identity, so each shell
// shows its own relevant events without leaking anything.
//
// Deliberately minimal: a bell with an unread-style count and a dropdown
// list. No toasts, no badges persisted anywhere, no notification center
// table — v1 derives everything at request time (see backend.ts scope note).
// ---------------------------------------------------------------------------

import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  AlertTriangle,
  Bell,
  BellOff,
  ClipboardList,
  Info,
  CheckCheck,
  Loader2,
  X,
  MessageSquareWarning,
  Building2,
  Mail,
  UserCog,
  UserPlus,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

const KIND_ICON = {
  ca_deadline: ClipboardList,
  ca_decision: ClipboardList,
  report_status: MessageSquareWarning,
  // company administration (migration 0034)
  org_invitation: Mail,
  org_request: UserPlus,
  org_decision: UserCog,
  org_role: UserCog,
  org_status: Building2,
} as const;

export interface BellNotification {
  notificationId: string;
  kind: keyof typeof KIND_ICON;
  severity: "urgent" | "warning" | "info";
  title: string;
  body?: string | null;
  linkTo: string;
  at: number | string;
  read: boolean;
}

export interface NotificationBellViewProps {
  /** undefined while loading */
  notifs: ReadonlyArray<BellNotification> | undefined;
  onMarkRead: (id: string) => void;
  onMarkAllRead: () => void;
  onDismiss: (id: string) => void;
  onDismissAll: () => void;
  /** Which side of the bell the panel opens on. Bells that sit at the bottom
   *  of a sidebar pass "top"; the default suits a header. The panel is
   *  portaled to <body> and collision-aware, so it can never be clipped by,
   *  or positioned outside, the screen — on phones or desktops. */
  side?: "top" | "bottom";
  align?: "start" | "end";
}

export function NotificationBellView({
  notifs: notifQ,
  onMarkRead,
  onMarkAllRead,
  onDismiss,
  onDismissAll,
  side = "bottom",
  align = "end",
}: NotificationBellViewProps) {
  const [open, setOpen] = useState(false);

  const notifs = notifQ ?? [];
  // The badge counts what has not been read yet; read items stay listed
  // (dimmed) until dismissed — state is stored per account (migration 0021).
  const unread = notifs.filter((n) => !n.read);
  const urgent = unread.filter((n) => n.severity === "urgent").length;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative text-muted-foreground"
          aria-label={`Notifications${unread.length > 0 ? ` (${unread.length} unread)` : ""}`}
        >
          <Bell className="size-4" strokeWidth={1.5} />
          {unread.length > 0 && (
            <span
              className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold ${
                urgent > 0
                  ? "bg-destructive text-destructive-foreground"
                  : "bg-primary text-primary-foreground"
              }`}
            >
              {unread.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      {/* Portaled to <body> and positioned by Radix against the VISUAL
          viewport: it flips/shifts to stay fully on screen (it used to be
          `absolute right-0` under the bell, which put it off the left/bottom
          edge for a bell in the sidebar footer or beside the header's other
          buttons). Click-away, Escape and focus return are built in. */}
      <PopoverContent
        side={side}
        align={align}
        sideOffset={6}
        collisionPadding={8}
        className="flex max-h-[min(32rem,var(--radix-popover-content-available-height))] w-80 max-w-[calc(100vw-1rem)] flex-col overflow-hidden bg-card p-0"
      >
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <p className="kicker text-[10px]">Notifications</p>
            {notifQ === undefined && (
              <Loader2 className="size-3 animate-spin text-muted-foreground" />
            )}
            {notifs.length > 0 && (
              <span className="flex items-center gap-2">
                {unread.length > 0 && (
                  <button
                    type="button"
                    className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
                    onClick={() => onMarkAllRead()}
                  >
                    <CheckCheck className="size-3" /> Mark all read
                  </button>
                )}
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => onDismissAll()}
                >
                  Dismiss all
                </button>
              </span>
            )}
            {notifQ !== undefined && notifs.length === 0 && (
              <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <BellOff className="size-3" /> nothing needs attention
              </span>
            )}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {notifs.length === 0 && notifQ !== undefined && (
              <p className="px-3 py-4 text-xs text-muted-foreground">
                You are all caught up. Deadline warnings and review decisions
                appear here as they arise.
              </p>
            )}
            {notifs.map((n) => {
              const Icon = KIND_ICON[n.kind];
              return (
                <div
                  key={n.notificationId}
                  className={`relative border-b border-border/60 transition-colors last:border-0 hover:bg-accent/50 ${n.read ? "opacity-60" : ""}`}
                >
                  <Link
                    to={n.linkTo}
                    onClick={() => {
                      if (!n.read) onMarkRead(n.notificationId);
                      setOpen(false);
                    }}
                    className="block px-3 py-2.5 pr-8"
                  >
                    <div className="flex items-start gap-2">
                      {n.severity === "urgent" ? (
                        <AlertTriangle
                          className="mt-0.5 size-3.5 shrink-0 text-destructive"
                          strokeWidth={1.5}
                        />
                      ) : n.severity === "warning" ? (
                        <Bell
                          className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400"
                          strokeWidth={1.5}
                        />
                      ) : (
                        <Info
                          className="mt-0.5 size-3.5 shrink-0 text-muted-foreground"
                          strokeWidth={1.5}
                        />
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-medium leading-snug">
                          {!n.read && (
                            <span
                              className="mr-1 inline-block size-1.5 rounded-full bg-primary align-middle"
                              aria-label="unread"
                            />
                          )}
                          {n.title}
                        </p>
                        {n.body && (
                          <p className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                            {n.body}
                          </p>
                        )}
                        <p className="mt-0.5 flex items-center gap-1 text-[10px] text-muted-foreground">
                          <Icon className="size-2.5" />
                          {new Date(n.at).toLocaleDateString()}
                        </p>
                      </div>
                    </div>
                  </Link>
                  <button
                    type="button"
                    aria-label={`Dismiss: ${n.title}`}
                    className="absolute right-1.5 top-2 rounded p-1 text-muted-foreground hover:text-foreground"
                    onClick={() => onDismiss(n.notificationId)}
                  >
                    <X className="size-3" />
                  </button>
                </div>
              );
            })}
          </div>
          <p className="border-t border-border px-3 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
            In-app notifications only. Email/push/SMS delivery is not configured
            (REQUIRES GOVERNMENT/OWNER CONFIRMATION).
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}
