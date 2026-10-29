// ---------------------------------------------------------------------------
// JOIN A COMPANY (Phase C) — a signed-in person with no role asks an approved
// company to add them. The request goes to that company's administrators;
// nothing is granted until one approves. Searching or typing a name is only a
// way to find the company — it never binds the account.
// ---------------------------------------------------------------------------

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import type { CompanySearchResult } from "@/lib/types";
import { Building2, Loader2, Search } from "lucide-react";
import { useState } from "react";
import { Link, Navigate } from "react-router";
import { toast } from "sonner";

export default function Join() {
  const { isLoading, isAuthenticated, user } = useAuth();
  const mine = useQuery(api.workforce.myMembership);
  const [q, setQ] = useState("");
  const [results, setResults] = useState<CompanySearchResult[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (isLoading) return <p className="p-6 text-sm text-muted-foreground" role="status">Loading…</p>;
  if (!isAuthenticated) return <Navigate to="/auth?returnTo=%2Fjoin" replace />;
  if (user?.role && !mine) {
    // Staff accounts and accounts that already have a workspace have nothing to join.
    return <Navigate to={user.role === "operator" ? "/operate" : user.role === "registrar" ? "/registry" : "/portal"} replace />;
  }

  async function search() {
    setError(null);
    if (q.trim().length < 3) return setError("Type at least 3 letters of the company name.");
    setBusy(true);
    try {
      setResults(await api.workforce.searchCompanies({ query: q.trim() }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Search failed.");
    } finally {
      setBusy(false);
    }
  }

  async function request(id: string, name: string) {
    setBusy(true);
    setError(null);
    try {
      await api.workforce.requestMembership({ organizationId: id });
      toast.success(`Request sent to ${name}.`);
      setResults(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not send the request.");
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.workforce.cancelRequest();
      toast.success("Request cancelled.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not cancel.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-lg flex-col gap-6 p-4 sm:p-8">
      <header>
        <p className="kicker">MineGuard Liberia</p>
        <h1 className="display mt-1 text-2xl">Join a company</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Ask your company to add you. Its administrators review every request — you get access only once one approves.
        </p>
      </header>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">{error}</p>
      )}

      {mine?.memberStatus === "pending" ? (
        <Card>
          <CardHeader><CardTitle className="flex items-center gap-2 text-base"><Building2 className="size-4" strokeWidth={1.5} />{mine.organizationName}</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            <Badge variant="secondary">Waiting for approval</Badge>
            <p className="text-muted-foreground">
              Your request is with the company's administrators. You'll be able to open your workspace as soon as it's approved.
            </p>
            <Button variant="outline" disabled={busy} onClick={() => void cancel()}>
              {busy && <Loader2 className="size-4 animate-spin" />} Cancel request
            </Button>
          </CardContent>
        </Card>
      ) : mine?.memberStatus === "active" ? (
        <Card>
          <CardContent className="space-y-3 pt-6 text-sm">
            <p className="font-medium">You've been added to {mine.organizationName}.</p>
            <Button asChild><Link to="/operate">Open my workspace</Link></Button>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader><CardTitle className="text-base">Find your company</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <Label htmlFor="join-q">Company name</Label>
            <div className="flex gap-2">
              <Input id="join-q" value={q} placeholder="e.g. ArcelorMittal" onChange={(e) => setQ(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") void search(); }} />
              <Button variant="outline" disabled={busy} onClick={() => void search()} aria-label="Search companies">
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />}
              </Button>
            </div>
            {results && results.length === 0 && (
              <p className="text-sm text-muted-foreground">No approved company matches that name.</p>
            )}
            {results && results.length > 0 && (
              <ul className="space-y-2">
                {results.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border p-3">
                    <span className="min-w-0 break-words text-sm font-medium">{r.name}</span>
                    <Button size="sm" disabled={busy} onClick={() => void request(r.id, r.name)}>Request to join</Button>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      )}

      <p className="text-center text-xs text-muted-foreground">
        Have an invitation email? <Link className="underline" to="/invitation">Accept it here</Link>.
      </p>
    </main>
  );
}
