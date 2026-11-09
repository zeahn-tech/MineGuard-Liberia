import { Link, useNavigate } from "react-router";
import { useAuth } from "@/hooks/use-auth";
import { useQuery } from "@/lib/backend-react";
import { api } from "@/lib/backend";
import { PublicHeader } from "@/components/PublicHeader";
import { ApprovedStatistics } from "@/components/ApprovedStatistics";
import { Button } from "@/components/ui/button";
import { BookOpen, FileText, Megaphone, MessageSquare, ShieldCheck, ShieldAlert, UserRound, KeyRound, FilePlus2 } from "lucide-react";

type Card = { to: string; title: string; text: string; icon: typeof BookOpen };

const PUBLIC_CARDS: Card[] = [
  { to: "/public/safety", title: "Safety information", text: "Approved guidance on staying safe around mining.", icon: ShieldCheck },
  { to: "/public/glossary", title: "Mining glossary", text: "Search and browse mining terms.", icon: BookOpen },
  { to: "/public/notices", title: "Public notices", text: "Announcements from the Ministry.", icon: Megaphone },
  { to: "/report", title: "Report a concern", text: "Dangerous activity, accidents, environmental or working-condition concerns.", icon: FilePlus2 },
];

/** The signed-in public user's home. Everything personal is read through the database's own
 *  checks (migrations 0048/0049); this page only lays out the entry points. */
export default function AccountHome() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();
  const accessClass = useQuery(api.account.accessClass);
  const restricted = accessClass === "restricted";

  const personal: Card[] = [
    { to: "/account/reports", title: "My reports", text: "Follow the reports you linked to your account.", icon: FileText },
    { to: "/account/feedback", title: "Feedback and questions", text: "Write to the Ministry and read the answer.", icon: MessageSquare },
    { to: "/account/profile", title: "My profile", text: "Your name, photo and account deletion.", icon: UserRound },
    { to: "/account/security", title: "Password and sign-in", text: "Change your password or set up an authenticator.", icon: KeyRound },
  ];

  return (
    <div className="min-h-screen bg-background paper-grain">
      <PublicHeader width="3xl">
        <Button
          variant="ghost"
          size="sm"
          onClick={async () => {
            await signOut();
            navigate("/", { replace: true });
          }}
        >
          Sign out
        </Button>
      </PublicHeader>
      <main className="mx-auto max-w-3xl px-4 py-10 md:px-8">
        <p className="kicker">My account</p>
        <h1 className="display mt-2 text-3xl md:text-4xl">{user?.name ? `Welcome, ${user.name}` : "Welcome"}</h1>
        <p className="mt-4 text-sm leading-relaxed text-muted-foreground">
          This is your public account. It gives you approved public information, a way to report mining
          concerns and follow your own reports. It does not give access to company or Ministry records.
        </p>

        {restricted && (
          <div role="alert" className="mt-6 flex gap-3 rounded-md border border-destructive/50 p-4 text-sm">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" />
            <p>
              Public account features are paused for this account. You can still read public information
              and your earlier reports. Contact the Ministry program office if you think this is a mistake.
            </p>
          </div>
        )}

        <h2 className="display mt-10 text-xl">Yours</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {personal.map((c) => (
            <Link key={c.to} to={c.to} className="paper flex gap-3 p-4 hover:bg-muted/30">
              <c.icon className="mt-0.5 size-5 shrink-0" strokeWidth={1.5} />
              <span>
                <span className="block font-medium">{c.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{c.text}</span>
              </span>
            </Link>
          ))}
        </div>

        <h2 className="display mt-10 text-xl">Public information</h2>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          {PUBLIC_CARDS.map((c) => (
            <Link key={c.to} to={c.to} className="paper flex gap-3 p-4 hover:bg-muted/30">
              <c.icon className="mt-0.5 size-5 shrink-0" strokeWidth={1.5} />
              <span>
                <span className="block font-medium">{c.title}</span>
                <span className="mt-1 block text-sm text-muted-foreground">{c.text}</span>
              </span>
            </Link>
          ))}
        </div>

        <div className="mt-10 border-y border-border">
          <ApprovedStatistics />
        </div>
      </main>
    </div>
  );
}
