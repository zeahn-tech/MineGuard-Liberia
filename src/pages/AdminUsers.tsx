// ---------------------------------------------------------------------------
// USERS (Ministry administrators, migration 0039): find a person and either end their
// company membership (the account stays) or remove the account. Removing an account
// keeps every safety record they created, shown as "Deleted user". Nothing here is a
// shortcut around the rules: the database re-checks authority, the blockers (last
// platform administrator, a company's only administrator) and the typed email, and the
// server re-verifies the administrator's password.
// ---------------------------------------------------------------------------
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/backend";
import type { AdminUserRow } from "@/lib/types";
import { Loader2, Search, ShieldAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrator", supervisor: "Supervisor", inspector: "Inspector", registrar: "Company registrar", operator: "Company user",
};
const ORG_ROLE: Record<string, string> = {
  company_admin: "Company administrator", site_manager: "Site manager", safety_officer: "Safety officer",
  onboarding_officer: "Onboarding officer", worker: "Worker",
};

export default function AdminUsers() {
  const { user } = useAuth();
  const [query, setQuery] = useState("");
  const [term, setTerm] = useState("");
  const [rows, setRows] = useState<AdminUserRow[] | null>(null);
  const [offset, setOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [target, setTarget] = useState<AdminUserRow | null>(null);
  const [mode, setMode] = useState<"company" | "account" | null>(null);
  const [blockers, setBlockers] = useState<{ code: string; message: string }[] | null>(null);
  const [typed, setTyped] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (user?.role !== "admin") return;
    let live = true;
    api.adminUsers
      .search({ query: term, offset: 0 })
      .then((r) => {
        if (!live) return;
        setRows(r);
        setOffset(r.length);
        setMore(r.length === 25);
        setLoadError(null);
      })
      .catch((e: unknown) => live && setLoadError(e instanceof Error ? e.message : "People could not be loaded."));
    return () => {
      live = false;
    };
  }, [term, reload, user?.role]);

  if (!user) return null;
  if (user.role !== "admin") {
    return (
      <div className="paper flex items-start gap-3 p-6">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.5} />
        <p className="text-sm">Managing people is limited to Ministry administrators.</p>
      </div>
    );
  }

  async function loadMore() {
    const r = await api.adminUsers.search({ query: term, offset });
    setRows((cur) => [...(cur ?? []), ...r]);
    setOffset((o) => o + r.length);
    setMore(r.length === 25);
  }

  function open(row: AdminUserRow, m: "company" | "account") {
    setTarget(row);
    setMode(m);
    setBlockers(null);
    setTyped("");
    setPassword("");
    setError(null);
    if (m === "account") {
      api.adminUsers.blockers({ userId: row.userId }).then(setBlockers).catch((e: Error) => setError(e.message));
    }
  }
  const close = () => { if (!busy) { setTarget(null); setMode(null); } };

  async function confirm() {
    if (!target || !mode) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === "company") {
        await api.adminUsers.removeFromCompany({ memberId: target.memberId! });
        toast.success("Removed from the company. The account still exists.");
      } else {
        const r = await api.adminUsers.deleteAccount({ userId: target.userId, confirmEmail: typed, password });
        toast.success(r.mode === "removed" ? "Account deleted." : "Account removed; their safety records are kept as “Deleted user”.");
      }
      setTarget(null);
      setMode(null);
      setReload((n) => n + 1);
    } catch (e) {
      setError(e instanceof Error ? e.message : "That did not work.");
    } finally {
      setBusy(false);
    }
  }

  const blocked = mode === "account" && (blockers === null || blockers.length > 0);

  return (
    <div className="min-w-0 space-y-6">
      <header>
        <p className="kicker">Administration</p>
        <h1 className="display mt-1 text-2xl sm:text-3xl">Users</h1>
        <p className="mt-2 max-w-2xl text-sm text-muted-foreground">
          Find a person to end their company membership or remove their account. Safety records they created are never deleted.
        </p>
      </header>

      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); setTerm(query.trim()); }} role="search">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search by name or email" aria-label="Search people" />
        <Button type="submit" variant="outline" aria-label="Search"><Search className="size-4" /></Button>
      </form>

      {loadError && <p role="alert" className="text-sm text-destructive">{loadError}</p>}
      {rows === null && !loadError ? (
        <p className="text-sm text-muted-foreground" role="status">Loading people…</p>
      ) : rows && rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">No one matches.</p>
      ) : (
        <ul className="space-y-2">
          {(rows ?? []).map((r) => {
            const me = r.userId === user.uid;
            return (
              <li key={r.userId} className="flex min-w-0 flex-col gap-2 rounded-md border p-3 sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <p className="break-words text-sm font-medium">{r.name ?? "Unnamed"} {me && <span className="text-xs text-muted-foreground">(you)</span>}</p>
                  <p className="break-all text-xs text-muted-foreground">{r.email}</p>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {r.removed ? <Badge variant="outline">Removed account</Badge> : r.role ? <Badge variant="secondary">{ROLE_LABEL[r.role] ?? r.role}</Badge> : <Badge variant="outline">No role</Badge>}
                    {r.company && <Badge variant="outline">{r.company}{r.orgRole ? ` · ${ORG_ROLE[r.orgRole] ?? r.orgRole}` : ""}</Badge>}
                  </div>
                </div>
                {!r.removed && !me && (
                  <div className="flex flex-wrap gap-2">
                    {r.memberId && <Button size="sm" variant="outline" onClick={() => open(r, "company")}>Remove from company</Button>}
                    <Button size="sm" variant="ghost" className="text-destructive" onClick={() => open(r, "account")}>Remove account…</Button>
                  </div>
                )}
                {me && <span className="text-xs text-muted-foreground">Use My profile to manage your own account.</span>}
              </li>
            );
          })}
        </ul>
      )}
      {more && <Button variant="outline" size="sm" onClick={() => void loadMore()}>Show more</Button>}

      <AlertDialog open={target !== null} onOpenChange={(o) => { if (!o) close(); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{mode === "company" ? "Remove from company?" : "Remove this account?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {mode === "company"
                ? `${target?.name ?? target?.email} loses all access to ${target?.company}. Their account and past reports stay.`
                : `${target?.name ?? target?.email} will no longer be able to sign in. Their personal details and photo are removed; safety records they created stay as “Deleted user”.`}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">{error}</p>}
          {mode === "account" && blockers && blockers.length > 0 && (
            <ul role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {blockers.map((b) => <li key={b.code + b.message}>{b.message}</li>)}
            </ul>
          )}
          {mode === "account" && !blocked && (
            <div className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="rm-email">Type their email to confirm: <span className="break-all font-mono text-xs">{target?.email}</span></Label>
                <Input id="rm-email" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="rm-pw">Your password</Label>
                <Input id="rm-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </div>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>Cancel</AlertDialogCancel>
            <Button
              variant="destructive"
              disabled={busy || (mode === "account" && (blocked || !password || typed.trim().toLowerCase() !== (target?.email ?? "").toLowerCase()))}
              onClick={() => void confirm()}
            >
              {busy && <Loader2 className="size-4 animate-spin" />} {mode === "company" ? "Remove from company" : "Remove account"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
