import { ContactLine, LegalLayout, P, Sub, UL, type LegalSection } from "@/components/LegalLayout";
import { reopenConsent, useConsent } from "@/lib/consent";
import { Link } from "react-router";

type Row = { name: string; where: string; purpose: string; keeps: string; kind: string };

// Keep this list in step with the code: tests/cookie-policy.test.ts fails if a
// storage key or cache used by the app is missing here.
const ROWS: Row[] = [
  {
    name: "mg.supabase.auth.v1",
    where: "localStorage",
    purpose: "Keeps you signed in (including the temporary guest session used to submit or track a report).",
    keeps: "Until you sign out; sign-in tokens expire and are renewed automatically.",
    kind: "Essential",
  },
  {
    name: "mg.consent.v1",
    where: "localStorage",
    purpose: "Remembers your choice in the cookie banner, the version of the choice, and when you made it.",
    keeps: "Until you change it or clear this site's data.",
    kind: "Essential",
  },
  {
    name: "mg.auth.recovery.v1",
    where: "sessionStorage",
    purpose: "Holds a password-reset in progress so a page reload does not lose it.",
    keeps: "Deleted when the browser tab closes.",
    kind: "Essential",
  },
  {
    name: "mg.onboarding.staff.v1",
    where: "sessionStorage",
    purpose: "Remembers that you chose \"Ministry or inspection staff\" on the welcome screen so it is not asked again while you finish onboarding.",
    keeps: "Deleted when the browser tab closes.",
    kind: "Essential",
  },
  {
    name: "mg.chunk-reload",
    where: "sessionStorage",
    purpose: "Stops the app reloading in a loop after an update.",
    keeps: "Deleted when the browser tab closes.",
    kind: "Essential",
  },
  {
    name: "mg.offline.store (entries: mg.offline.queue.v1, mg.offline.drafts.v1, mg.offline.refs.v1)",
    where: "IndexedDB (in some browsers or private modes the same entries are kept in localStorage instead)",
    purpose:
      "Offline queue of inspections, incidents and observations you saved while offline, unfinished field drafts, and references that link them once sent.",
    keeps:
      "Until the items are sent or you discard them. Removed when you sign out, provided nothing is still waiting to be sent.",
    kind: "Essential",
  },
  {
    name: "mg.offline.evidence",
    where: "IndexedDB",
    purpose: "Photos and files you attached offline, held until they can be uploaded.",
    keeps: "Until uploaded or discarded.",
    kind: "Essential",
  },
  {
    name: "mineguard-shell-*",
    where: "Cache Storage (service worker)",
    purpose: "A copy of the app's own files so it opens and works without a connection.",
    keeps: "Replaced when the app is updated.",
    kind: "Essential",
  },
  {
    name: "mg.install.v1",
    where: "localStorage",
    purpose:
      'Counts how often the "install the app" reminder has been shown or dismissed, and whether the app is installed, so it does not nag you.',
    keeps: "Until you clear this site's data.",
    kind: "Preference",
  },
  {
    name: "mgtiles-v1",
    where: "Cache Storage (service worker)",
    purpose: "Up to 1,500 map picture tiles you have already viewed (Liberia only), so they show again offline.",
    keeps: "Until deleted. Deleted automatically if you withdraw the map-background choice. Created only if you allow the map background.",
    kind: "Optional — only if you allow it",
  },
];

function CookieSettingsButton() {
  const c = useConsent();
  return (
    <p>
      <button
        type="button"
        onClick={reopenConsent}
        className="min-h-10 rounded-sm border border-border px-3 text-sm font-medium hover:bg-muted"
      >
        Open cookie settings
      </button>
      <span className="ml-3 text-xs text-muted-foreground">
        {c.decided ? `Map background: ${c.mapTiles ? "allowed" : "off"}` : "No choice made yet — map background is off"}
      </span>
    </p>
  );
}

const sections: LegalSection[] = [
  {
    id: "what",
    title: "What this policy covers",
    body: (
      <>
        <P>
          Cookies are small files a website places in your browser. Websites can also keep information in
          your browser using similar technologies: <strong>localStorage</strong> and{" "}
          <strong>sessionStorage</strong>, <strong>IndexedDB</strong>, and <strong>Cache Storage</strong>{" "}
          used by a <strong>service worker</strong> (the part that lets an app work offline). This policy
          covers all of them, because the app uses the last four rather than cookies. It explains exactly
          what MineGuard Liberia keeps on your device and why. How we handle your information more
          generally is in our{" "}
          <Link to="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>
          .
        </P>
      </>
    ),
  },
  {
    id: "cookies",
    title: "Cookies: we set none",
    body: (
      <>
        <P>
          MineGuard Liberia does <strong>not set any cookies</strong>. It does not use advertising,
          tracking, profiling or analytics cookies or scripts, no social-media plug-ins, and no
          third-party fonts or content networks. We do not build a profile of you, and we do not follow you
          across other websites.
        </P>
      </>
    ),
  },
  {
    id: "storage",
    title: "What the app stores on your device",
    body: (
      <>
        <P>
          <strong>Essential</strong> items are needed to provide the service you asked for (signing in,
          saving your work offline, opening the app). They cannot be switched off inside the app. A{" "}
          <strong>Preference</strong> is a small setting for your convenience. <strong>Optional</strong>{" "}
          items run only if you allow them.
        </P>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[40rem] border-collapse text-left text-xs">
            <thead>
              <tr className="border-b border-border">
                <th className="py-2 pr-3 font-semibold">Name</th>
                <th className="py-2 pr-3 font-semibold">Where</th>
                <th className="py-2 pr-3 font-semibold">What it is for</th>
                <th className="py-2 pr-3 font-semibold">How long</th>
                <th className="py-2 font-semibold">Type</th>
              </tr>
            </thead>
            <tbody>
              {ROWS.map((r) => (
                <tr key={r.name} className="border-b border-border/60 align-top">
                  <td className="py-2 pr-3 font-mono break-all">{r.name}</td>
                  <td className="py-2 pr-3">{r.where}</td>
                  <td className="py-2 pr-3">{r.purpose}</td>
                  <td className="py-2 pr-3">{r.keeps}</td>
                  <td className="py-2">{r.kind}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <P>
          Everything above stays on your device. None of it is used to identify you to other sites or to
          track you. Anyone who can use your unlocked device could see this stored data, so use a screen
          lock and sign out on shared devices.
        </P>
      </>
    ),
  },
  {
    id: "third",
    title: "Third parties",
    body: (
      <>
        <Sub>OpenStreetMap (optional map background)</Sub>
        <P>
          If you allow the map background, your browser requests map pictures directly from OpenStreetMap
          tile servers. That reveals your network (IP) address, your browser type and the part of the map
          you are viewing to that provider, under its own policy. If you do not allow it, no request is
          made: the maps still show boundaries, sites and markers on a plain background. Map data ©
          OpenStreetMap contributors.
        </P>
        <Sub>Our hosting and database provider</Sub>
        <P>
          The app needs to talk to its back-end service (hosted by Supabase) to sign you in, send reports
          and load data. This is necessary for the service to work, and it means that provider receives
          your network address and the requests you make, as described in our Privacy Policy. It does not
          involve advertising or tracking.
        </P>
      </>
    ),
  },
  {
    id: "choices",
    title: "Your choices",
    body: (
      <>
        <UL>
          <li>
            <strong>Banner.</strong> On your first visit you can choose <em>Essential only</em> or{" "}
            <em>Allow map background</em>. Nothing optional runs before you choose, and not choosing is
            the same as choosing Essential only.
          </li>
          <li>
            <strong>Change your mind at any time</strong> with the button below or the &quot;Cookie
            settings&quot; link in the footer. Withdrawing the map background deletes the map tiles saved
            on your device and stops further requests to the map provider.
          </li>
          <li>
            <strong>Browser controls.</strong> You can clear this site&apos;s data or block storage in your
            browser settings. Be aware that blocking essential storage can stop sign-in and offline saving
            from working, and clearing it removes any offline work not yet sent.
          </li>
        </UL>
        <CookieSettingsButton />
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes and contact",
    body: (
      <>
        <P>
          If we add anything that stores information on your device beyond what is listed here, we will
          update this policy and ask for your choice again where a choice is required. The version and
          effective date are shown at the top of this page.
        </P>
        <P>
          Questions about this policy? Please <ContactLine />.
        </P>
      </>
    ),
  },
];

export default function Cookies() {
  return (
    <LegalLayout
      kicker="Legal"
      title="Cookie Policy"
      intro={
        <P>
          The short version: we set no cookies, use no analytics or advertising, and keep only what the app
          needs on your device. The one optional item is the map background from OpenStreetMap, which is
          off unless you allow it.
        </P>
      }
      sections={sections}
      other={{ to: "/privacy", label: "Privacy Policy" }}
    />
  );
}
