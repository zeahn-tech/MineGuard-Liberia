import { ContactLine, LegalLayout, P, UL, type LegalSection } from "@/components/LegalLayout";
import { Link } from "react-router";

const sections: LegalSection[] = [
  {
    id: "agreement",
    title: "Agreement and who may use the platform",
    body: (
      <>
        <P>
          These Terms of Use govern your use of MineGuard Liberia (&quot;the platform&quot;), including
          the website, the installable app and the public reporting channel. By using the platform,
          creating an account or submitting a report, you agree to these Terms and to our{" "}
          <Link to="/privacy" className="underline underline-offset-4">
            Privacy Policy
          </Link>
          . If you do not agree, please do not use the platform.
        </P>
        <P>
          You must be an adult able to enter into this agreement, and if you use the platform on behalf
          of an organization you confirm you are authorized to do so. The public reporting channel and
          report tracking are open to anyone; all other features require an account that has been
          assigned a role.
        </P>
        <P>
          MineGuard Liberia is designed for potential government adoption and is{" "}
          <strong>not an official Government of Liberia system</strong>. Nothing on the platform is an
          official act, licence, ruling or legal advice of any government body unless an adopting
          institution expressly says so in writing.
        </P>
      </>
    ),
  },
  {
    id: "service",
    title: "What the platform does",
    body: (
      <>
        <P>The platform lets authorized personnel and mining operators:</P>
        <UL>
          <li>register and manage mining sites, with map locations and boundaries;</li>
          <li>carry out and review inspections using configurable templates, including offline in the
            field;</li>
          <li>record safety incidents and environmental observations, with photo, video, audio and
            document evidence;</li>
          <li>raise findings and follow corrective actions through to verification;</li>
          <li>review community reports and view reports, trends and an explainable risk indicator.</li>
        </UL>
        <P>
          It also lets the public submit a mining concern and follow its status using a tracking code.
          Features, screens and limits may change as the platform develops.
        </P>
      </>
    ),
  },
  {
    id: "accounts",
    title: "Accounts, roles and security",
    body: (
      <>
        <UL>
          <li>
            Access is role-based (administrator, supervisor, inspector or operator) and limited to a
            national or county scope, or to your own organization&apos;s sites. A new account has no
            platform role until an administrator assigns one. Do not try to access anything outside
            your role.
          </li>
          <li>
            Give accurate account information and keep it up to date. One account belongs to one
            person; do not share it.
          </li>
          <li>
            Keep your password and any two-factor codes secret. You are responsible for activity on
            your account until you tell us it has been compromised. Sign out on shared devices.
          </li>
          <li>
            Tell the program office promptly if you suspect unauthorized access.
          </li>
          <li>
            We may change, suspend or remove a role or account where needed to protect the platform,
            people or the integrity of records, or when your role ends.
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "use",
    title: "Acceptable use",
    body: (
      <>
        <P>You agree not to:</P>
        <UL>
          <li>submit information you know to be false or misleading, including false community
            reports, or make an inspection or verification entry you have not honestly carried out;</li>
          <li>use the platform to harass, threaten, retaliate against or expose a person, including a
            person who has made a report;</li>
          <li>upload unlawful material, material you have no right to share, or files containing
            malware;</li>
          <li>attempt to bypass access limits, probe for weaknesses, overload the platform, scrape or
            copy data you are not entitled to, or interfere with other users;</li>
          <li>use someone else&apos;s account, or give your access to others;</li>
          <li>include other people&apos;s personal details in a report or record unless they are
            necessary for the concern.</li>
        </UL>
        <P>
          Report security problems to the program office instead of exploiting them. We may remove
          content and limit or end access that breaches these Terms, and may refer serious misuse to
          the appropriate authorities.
        </P>
      </>
    ),
  },
  {
    id: "reports",
    title: "Community reports",
    body: (
      <>
        <UL>
          <li>
            A report is an <strong>allegation</strong>. Submitting one starts a human review; it does
            not start an enforcement action, and nothing is treated as proven until a named reviewer
            verifies it.
          </li>
          <li>
            We do not promise a response time, an outcome or any particular follow-up. Contact details
            are optional and used only for follow-up questions.
          </li>
          <li>
            Keep your tracking code to check progress. Anyone who has the code can see the
            report&apos;s status, so share it carefully.
          </li>
          <li>
            <strong>This is not an emergency service.</strong> If someone is in immediate danger, call
            the emergency services or the responsible authority directly.
          </li>
          <li>
            Please report in good faith and as accurately as you can. Deliberately false reports harm
            communities and may have legal consequences.
          </li>
        </UL>
      </>
    ),
  },
  {
    id: "content",
    title: "Records, evidence and your content",
    body: (
      <>
        <P>
          Information you submit (reports, inspection answers, notes, photos, files and similar) stays
          yours or your organization&apos;s. By submitting it you give the program and any institution
          that adopts the platform a non-exclusive right to store, process, review, display to
          authorized users and rely on it for oversight, safety, compliance and audit purposes.
        </P>
        <P>
          You confirm you have the right to submit it and that you obtained it lawfully. Evidence may
          show people or sensitive scenes: capture only what is needed and respect the safety and
          dignity of those involved.
        </P>
        <P>
          Platform records support accountability, so the platform does not permanently delete them. A
          mistake is fixed by adding a corrected, attributed entry, and an append-only audit trail
          records who changed what and when. Information you queue while offline is not recorded on the
          platform until it has been sent.
        </P>
      </>
    ),
  },
  {
    id: "indicators",
    title: "Risk indicators and assisted explanations",
    body: (
      <P>
        Risk scores, rankings, trends and the &quot;AI-assisted&quot; explanations are decision-support
        tools built from recorded data, with their workings shown. They can be wrong or out of date and
        depend on the quality of what has been entered. They are not findings of fact or of guilt, not
        a legal determination of compliance or violation, and not a substitute for professional
        judgment. Decisions and any enforcement remain with the responsible people and institutions.
      </P>
    ),
  },
  {
    id: "offline",
    title: "Offline use and installation",
    body: (
      <>
        <P>
          You can install the platform as an app and keep working without a connection. Data you save
          offline is held on your device and sent when you reconnect. You are responsible for keeping
          the device secure and for reconnecting so your work is sent; we cannot guarantee delivery of
          data that remains only on a device that is lost, damaged, reset or has its browser data
          cleared.
        </P>
        <P>
          Camera and location are used only with your permission and your action, as described in the
          Privacy Policy.
        </P>
      </>
    ),
  },
  {
    id: "thirdparty",
    title: "Third-party services and map data",
    body: (
      <P>
        The platform relies on third-party services such as cloud hosting, authentication and storage,
        email delivery and map tiles. Their availability and terms are outside our control. Map data is
        © OpenStreetMap contributors and available under the Open Database Licence (ODbL). Boundaries,
        site positions and distances on a map are for orientation and are not a survey or legal
        description of land.
      </P>
    ),
  },
  {
    id: "availability",
    title: "Availability and changes",
    body: (
      <P>
        We work to keep the platform available and accurate but it is provided on an &quot;as
        available&quot; basis. It may be unavailable for maintenance, connectivity problems or reasons
        beyond our control, and we may change, limit or discontinue features. Do not rely on the
        platform as your only means of meeting a legal, safety or reporting duty.
      </P>
    ),
  },
  {
    id: "liability",
    title: "Disclaimers and limits of liability",
    body: (
      <>
        <P>
          To the fullest extent permitted by law, the platform and its content are provided without
          warranties of any kind, express or implied, including accuracy, completeness, fitness for a
          particular purpose and uninterrupted or error-free operation.
        </P>
        <P>
          To the fullest extent permitted by law, the program and its operators are not liable for
          indirect, incidental or consequential loss, or for loss arising from reliance on information
          in the platform, from unavailability, or from data that was not sent from a device. Nothing
          in these Terms limits liability that cannot lawfully be limited, including for fraud or for
          death or personal injury caused by negligence.
        </P>
      </>
    ),
  },
  {
    id: "law",
    title: "Governing law",
    body: (
      <P>
        These Terms are governed by the laws of the Republic of Liberia, unless an institution that
        formally adopts the platform designates different governing terms in writing. The courts of
        Liberia have jurisdiction over disputes, subject to any mandatory rules that apply to you.
      </P>
    ),
  },
  {
    id: "changes",
    title: "Changes to these Terms and contact",
    body: (
      <>
        <P>
          We may update these Terms as the platform or its legal setting changes. The version and
          effective date are shown at the top of this page, and the updated Terms replace the old ones
          from that date. Continuing to use the platform after that date means you accept them. If any
          part of these Terms is found unenforceable, the rest continues to apply.
        </P>
        <P>
          Questions about these Terms: <ContactLine />.
        </P>
      </>
    ),
  },
];

export default function Terms() {
  return (
    <LegalLayout
      kicker="Legal"
      title="Terms of Use"
      intro={
        <P>
          Please read these Terms before you use MineGuard Liberia. In short: use the platform honestly
          and only within the access you have been given; a community report is an allegation reviewed
          by people, not an enforcement action; risk indicators support decisions but do not make them;
          and records are kept for accountability.
        </P>
      }
      sections={sections}
      other={{ to: "/privacy", label: "Privacy Policy" }}
    />
  );
}
