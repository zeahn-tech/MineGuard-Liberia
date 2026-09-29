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
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import {
  AlertTriangle,
  Bell,
  BellOff,
  ClipboardList,
  Info,
  Loader2,
  MessageSquareWarning,
} from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

const KIND_ICON = {
  ca_deadline: ClipboardList,
  ca_decision: ClipboardList,
  report_status: MessageSquareWarning,
} as const;

export default function NotificationBell() {
  const notifQ = useQuery(api.records.listNotifications);
  const [open, setOpen] = useState(false);

  const notifs = notifQ ?? [];
  const urgent = notifs.filter((n) => n.severity === "urgent").length;

  return (
    <div className="relative">
      <Button
        variant="ghost"
        size="sm"
        className="relative text-muted-foreground"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
        aria-label={`Notifications${notifs.length > 0 ? ` (${notifs.length})` : ""}`}
        aria-expanded={open}
        aria-haspopup="true"
      >
        <Bell className="size-4" strokeWidth={1.5} />
        {notifs.length > 0 && (
          <span
            className={`absolute -right-0.5 -top-0.5 flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[9px] font-semibold ${
              urgent > 0 ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"
            }`}
          >
            {notifs.length}
          </span>
        )}
      </Button>

      {open && (
        <>
          {/* click-away layer (pointer-only; keyboard users close via
              Escape or the toggle button) */}
          <div className="fixed inset-0 z-40" aria-hidden="true" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-50 mt-1 w-80 rounded border border-border bg-card shadow-lg">
            <div className="flex items-center justify-between border-b border-border px-3 py-2">
              <p className="kicker text-[10px]">Notifications</p>
              {notifQ === undefined && <Loader2 className="size-3 animate-spin text-muted-foreground" />}
              {notifQ !== undefined && notifs.length === 0 && (
                <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                  <BellOff className="size-3" /> nothing needs attention
                </span>
              )}
            </div>
            <div className="max-h-80 overflow-y-auto">
              {notifs.length === 0 && notifQ !== undefined && (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  You are all caught up. Deadline warnings and review decisions
                  appear here as they arise.
                </p>
              )}
              {notifs.map((n) => {
                const Icon = KIND_ICON[n.kind];
                return (
                  <Link
                    key={n.id}
                    to={n.linkTo}
                    onClick={() => setOpen(false)}
                    className="block border-b border-border/60 px-3 py-2.5 transition-colors last:border-0 hover:bg-accent/50"
                  >
                    <div className="flex items-start gap-2">
                      {n.severity === "urgent" ? (
                        <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-destructive" strokeWidth={1.5} />
                      ) : n.severity === "warning" ? (
                        <Bell className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" strokeWidth={1.5} />
                      ) : (
                        <Info className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
                      )}
                      <div className="min-w-0">
                        <p className="text-xs font-medium leading-snug">{n.title}</p>
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
                );
              })}
            </div>
            <p className="border-t border-border px-3 py-1.5 text-[10px] leading-relaxed text-muted-foreground">
              In-app notifications only. Email/push/SMS delivery is not
              configured (REQUIRES GOVERNMENT/OWNER CONFIRMATION).
            </p>
          </div>
        </>
      )}
    </div>
  );
}
