// A person's photo (private, fetched through a short-lived signed link) or their initials.
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { api } from "@/lib/backend";
import { initialsOf } from "@/lib/avatar-image";
import { cachedAvatar, rememberAvatar } from "@/lib/avatar-cache";
import { useEffect, useState } from "react";

export function UserAvatar({
  name,
  email,
  avatarPath,
  className,
}: {
  name?: string | null;
  email?: string | null;
  avatarPath?: string | null;
  className?: string;
}) {
  const [fetched, setFetched] = useState<{ path: string; url: string | null } | null>(null);
  const cached = avatarPath ? cachedAvatar(avatarPath) : undefined;

  useEffect(() => {
    if (!avatarPath || cachedAvatar(avatarPath) !== undefined) return;
    let live = true;
    void api.account.avatarUrl(avatarPath).then((u) => {
      rememberAvatar(avatarPath, u);
      if (live) setFetched({ path: avatarPath, url: u });
    });
    return () => {
      live = false;
    };
  }, [avatarPath]);

  const url = !avatarPath ? null : cached !== undefined ? cached : fetched?.path === avatarPath ? fetched.url : null;

  return (
    <Avatar className={className}>
      {url && <AvatarImage src={url} alt="" />}
      <AvatarFallback aria-hidden>{initialsOf(name, email)}</AvatarFallback>
    </Avatar>
  );
}
