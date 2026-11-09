// ---------------------------------------------------------------------------
// MY PROFILE — one page for every role (staff, company people, registrar): photo,
// name and job title, a link to password / authenticator settings, and "Delete my
// account". Role, company and email are shown but changed only by an administrator.
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
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { UserAvatar } from "@/components/UserAvatar";
import { forgetAvatar } from "@/lib/avatar-cache";
import { useAuth } from "@/hooks/use-auth";
import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import { AVATAR_ACCEPT, prepareAvatar, validateAvatarFile } from "@/lib/avatar-image";
import { Camera, Loader2, ShieldAlert, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { toast } from "sonner";
import { FormField } from "@/components/FormField";
import { errorSentence } from "@/lib/error-messages";

const ROLE_LABEL: Record<string, string> = {
  admin: "Administrator",
  supervisor: "Supervisor",
  inspector: "Inspector",
  registrar: "Company registrar",
  operator: "Company user",
};

function securityPath(role: string | undefined): string {
  if (role === "operator") return "/operate/security";
  if (role === "registrar") return "/registry/security";
  if (!role) return "/account/security"; // public account (no platform role)
  return "/portal/security";
}

export default function ProfileSettings() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const membership = useQuery(api.workforce.myMembership);
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState<string | null>(null);
  const [title, setTitle] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [blockers, setBlockers] = useState<{ code: string; message: string }[] | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [typed, setTyped] = useState("");
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!user) return null;
  const nameValue = name ?? user.name ?? "";
  const titleValue = title ?? user.jobTitle ?? "";
  const dirty = nameValue.trim() !== (user.name ?? "") || titleValue.trim() !== (user.jobTitle ?? "");
  // Say WHY Save is unavailable, at the field, instead of just greying it out.
  const nameProblem =
    dirty && nameValue.trim().length < 2 ? "Enter your full name — at least 2 characters." : undefined;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await api.account.updateProfile({ name: nameValue, jobTitle: titleValue });
      setName(null);
      setTitle(null);
      toast.success("Profile saved.");
    } catch (e) {
      setError(errorSentence(e, { action: "save your profile" }));
    } finally {
      setSaving(false);
    }
  }

  async function pickPhoto(file: File | undefined) {
    if (!file) return;
    setError(null);
    const problem = validateAvatarFile(file);
    if (problem) return setError(problem);
    setPhotoBusy(true);
    try {
      const small = await prepareAvatar(file);
      forgetAvatar(user!.avatarPath);
      await api.account.uploadAvatar(small);
      toast.success("Photo updated.");
    } catch (e) {
      setError(errorSentence(e, { action: "update your photo" }));
    } finally {
      setPhotoBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  async function removePhoto() {
    setPhotoBusy(true);
    setError(null);
    try {
      forgetAvatar(user!.avatarPath);
      await api.account.removeAvatar();
      toast.success("Photo removed.");
    } catch (e) {
      setError(errorSentence(e, { action: "remove your photo" }));
    } finally {
      setPhotoBusy(false);
    }
  }

  async function openDelete() {
    setError(null);
    try {
      const b = await api.account.deletionBlockers();
      setBlockers(b);
      if (b.length === 0) {
        setPassword("");
        setTyped("");
        setConfirmOpen(true);
      }
    } catch (e) {
      setError(errorSentence(e, { action: "check whether your account can be deleted" }));
    }
  }

  async function reallyDelete() {
    setDeleting(true);
    setError(null);
    try {
      await api.account.deleteAccount({ password });
      setConfirmOpen(false);
      toast.success("Your account has been deleted.");
      navigate("/", { replace: true });
    } catch (e) {
      setError(errorSentence(e, { action: "delete your account" }));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="mx-auto min-w-0 max-w-2xl space-y-6">
      <header>
        <p className="kicker">Account</p>
        <h1 className="display mt-1 text-2xl sm:text-3xl">My profile</h1>
      </header>

      {error && (
        <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      <Card>
        <CardHeader><CardTitle className="text-base">Photo</CardTitle></CardHeader>
        <CardContent className="flex flex-wrap items-center gap-4">
          <UserAvatar name={user.name} email={user.email} avatarPath={user.avatarPath} className="size-20 text-xl" />
          <div className="space-y-2">
            <input ref={fileRef} type="file" accept={AVATAR_ACCEPT} className="sr-only" id="avatar-file"
              aria-label="Choose a profile photo" onChange={(e) => void pickPhoto(e.target.files?.[0])} />
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" disabled={photoBusy} onClick={() => fileRef.current?.click()}>
                {photoBusy ? <Loader2 className="size-4 animate-spin" /> : <Camera className="size-4" />}
                {user.avatarPath ? "Change photo" : "Upload photo"}
              </Button>
              {user.avatarPath && (
                <Button variant="ghost" size="sm" disabled={photoBusy} onClick={() => void removePhoto()}>Remove</Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">
              JPEG, PNG or WebP. It is cropped to a small square on your device first, so location data in the
              original is not kept. Only you can see it.
            </p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Your details</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <FormField label="Full name" id="pf-name" error={nameProblem} className="space-y-1">
            {(a11y) => (
              <Input {...a11y} value={nameValue} maxLength={120} autoComplete="name" onChange={(e) => setName(e.target.value)} />
            )}
          </FormField>
          <div className="space-y-1">
            <Label htmlFor="pf-title">Job title</Label>
            <Input id="pf-title" value={titleValue} maxLength={120} autoComplete="organization-title" onChange={(e) => setTitle(e.target.value)} />
          </div>
          <dl className="grid gap-3 text-sm sm:grid-cols-2">
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Email</dt>
              <dd className="break-all">{user.email}</dd>
            </div>
            <div className="min-w-0">
              <dt className="text-xs text-muted-foreground">Role</dt>
              <dd>{user.role ? ROLE_LABEL[user.role] ?? user.role : "Not assigned yet"}</dd>
            </div>
            {user.role === "operator" && membership && (
              <div className="min-w-0 sm:col-span-2">
                <dt className="text-xs text-muted-foreground">Company</dt>
                <dd className="break-words">{membership.organizationName}</dd>
              </div>
            )}
          </dl>
          <p className="text-xs text-muted-foreground">Your role, company and email are changed by an administrator.</p>
          <div className="flex flex-wrap items-center gap-3">
            <Button disabled={!dirty || saving || nameValue.trim().length < 2} onClick={() => void save()}>
              {saving && <Loader2 className="size-4 animate-spin" />} Save changes
            </Button>
            <Link to={securityPath(user.role)} className="text-sm underline underline-offset-2">
              Password and authenticator settings
            </Link>
          </div>
        </CardContent>
      </Card>

      <Card className="border-destructive/40">
        <CardHeader><CardTitle className="flex items-center gap-2 text-base"><ShieldAlert className="size-4 text-destructive" /> Delete my account</CardTitle></CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>
            This signs you out for good and removes your personal details, photo and notifications. It cannot be undone.
          </p>
          <p className="text-xs text-muted-foreground">
            Sites, inspections, findings, incidents and other safety records you created are <strong>not deleted</strong>:
            they stay for the public record, shown as &ldquo;Deleted user&rdquo;. If you created none, your sign-in is
            removed completely.
          </p>
          {blockers && blockers.length > 0 && (
            <ul role="alert" className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-xs text-destructive">
              {blockers.map((b) => <li key={b.code + b.message}>{b.message}</li>)}
            </ul>
          )}
          <Button variant="outline" className="border-destructive/50 text-destructive hover:bg-destructive/10" onClick={() => void openDelete()}>
            <Trash2 className="size-4" /> Delete my account…
          </Button>
        </CardContent>
      </Card>

      <AlertDialog open={confirmOpen} onOpenChange={(o) => { if (!deleting) setConfirmOpen(o); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete your account?</AlertDialogTitle>
            <AlertDialogDescription>
              You will be signed out and will not be able to sign in again. To confirm it is you, enter your password and type DELETE.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="del-pw">Password</Label>
              <Input id="del-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </div>
            <div className="space-y-1">
              <Label htmlFor="del-typed">Type DELETE</Label>
              <Input id="del-typed" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />
            </div>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <Button variant="destructive" disabled={deleting || !password || typed !== "DELETE"} onClick={() => void reallyDelete()}>
              {deleting && <Loader2 className="size-4 animate-spin" />} Delete my account
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
