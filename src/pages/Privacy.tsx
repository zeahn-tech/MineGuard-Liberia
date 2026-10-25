import { ContactLine, LegalLayout, P, Sub, UL, type LegalSection } from "@/components/LegalLayout";
import { Link } from "react-router";

const sections: LegalSection[] = [
  {
    id: "who",
    title: "Who this policy covers",
    body: (
      <>
        <P>
          MineGuard Liberia (&quot;MineGuard&quot;, &quot;the platform&quot;, &quot;we&quot;) is a
          mining-sector oversight platform. It helps authorized personnel register mining sites, record
          inspections, safety incidents and environmental observations, follow corrective actions,
          and review concerns raised by the public. It also gives anyone a way to report a mining
          concern without creating an account.
        </P>
        <P>
          This policy explains what information the platform collects, why, who can see it, how it is
          protected and what choices you have. It applies to everyone who uses the platform:
          government and program staff (administrators, supervisors and inspectors), mining operators,
          and members of the public who submit or track a report.
        </P>
        <P>
          MineGuard Liberia is designed for potential government adoption. It is{" "}
          <strong>not an official Government of Liberia system</strong>. If an institution formally
          adopts the platform it becomes responsible for the records held in it and may supplement this
          policy.
        </P>
      </>
    ),
  },
  {
    id: "collect",
    title: "Information we collect",
    body: (
      <>
        <Sub>If you submit a community report (no account needed)</Sub>
        <UL>
          <li>The category of concern, the county, and optionally the district and community.</li>
          <li>Your description of what you observed.</li>
          <li>
            <strong>Optional:</strong> a contact phone number and GPS coordinates. You can leave both
            blank.
          </li>
          <li>
            A tracking code generated for your report, and the date and review status of the report.
          </li>
          <li>
            A one-way, salted fingerprint of your network address, used only to limit abuse of the
            form (see section 8). Your actual address is not stored in the report.
          </li>
        </UL>
        <P>
          We do not ask for your name, national ID or any biometric data. Please do not include other
          people&apos;s personal details in a report unless they are essential to the concern.
        </P>

        <Sub>If you have an account (staff and operators)</Sub>
        <UL>
          <li>
            Account details: email address, name, job title, organization, and the role, scope
            (national or county) and county or operator assigned to you. Your password is handled by
            the authentication service and is not readable by us.
          </li>
          <li>
            Two-factor authentication: if you enable it, the authentication service stores the factor
            needed to verify your sign-in codes.
          </li>
          <li>
            Work you record: sites (name, code, operator, county, coordinates and boundaries),
            inspections and checklist answers, findings, corrective actions and your responses,
            safety incidents, environmental observations, review decisions and notes.
          </li>
          <li>
            Evidence you attach: photos, video, audio and documents (up to 25 MB each) with an
            optional caption, who uploaded them, when, and a file fingerprint (SHA-256) used to
            confirm a file was not altered.
          </li>
          <li>
            Activity records: an audit log of consequential actions (who did what, to which record,
            and when), and a record of each time a temporary evidence link is issued.
          </li>
          <li>In-app notifications generated for you about records you can access.</li>
        </UL>

        <Sub>From your device, only with your action or permission</Sub>
        <UL>
          <li>
            <strong>Location:</strong> used only when you choose &quot;use my location&quot; while
            placing a site, or type coordinates yourself. The platform does not track your location in
            the background.
          </li>
          <li>
            <strong>Camera:</strong> used only while you take a photo to attach as evidence. Nothing
            is captured until you press the capture control.
          </li>
          <li>
            <strong>Files:</strong> only the files you pick to upload.
          </li>
        </UL>

        <Sub>Technical data</Sub>
        <P>
          Like any web service, the hosting providers named in section 5 receive standard request data
          (such as network address, browser type and time of request) when you load the app or make a
          request. The platform itself does not add advertising or behavioral-tracking tools and does
          not run third-party analytics.
        </P>
      </>
    ),
  },
  {
    id: "use",
    title: "How we use information",
    body: (
      <>
        <UL>
          <li>To run the oversight workflow: registering sites, inspections, incidents, environmental
            observations and corrective actions, and tracking them to resolution.</li>
          <li>To review and triage community reports. A report is an allegation; it starts a human
            review and is never, by itself, a finding or an enforcement action.</li>
          <li>To authenticate you, apply the role and county or operator limits assigned to you, and
            keep accounts secure.</li>
          <li>To keep an accountable record: every consequential change is attributed to the person
            who made it.</li>
          <li>To show aggregate statistics, trend reports and an explainable risk indicator to people
            authorized to see them.</li>
          <li>To work offline in the field and send queued data when a connection returns.</li>
          <li>To protect the platform from abuse, errors and security incidents.</li>
        </UL>
        <Sub>Risk indicator and automated assistance</Sub>
        <P>
          The risk indicator ranks sites using documented, adjustable weights over recorded facts, and
          every score shows its breakdown. An &quot;AI-assisted&quot; label marks an explanation of
          that breakdown; it is produced by fixed arithmetic inside the platform, not by sending your
          data to an outside AI provider. Neither the indicator nor the explanation is a determination
          of wrongdoing, and no enforcement decision is made automatically: people review and decide.
        </P>
        <P>We do not sell personal information or use it for advertising or profiling.</P>
      </>
    ),
  },
  {
    id: "see",
    title: "Who can see it",
    body: (
      <>
        <UL>
          <li>
            <strong>The public</strong> can see only what a tracking code reveals (the code, the
            status and the date) and aggregate counts. Report text, contact numbers and coordinates
            are not shown publicly.
          </li>
          <li>
            <strong>Program staff</strong> see records within the national or county scope assigned to
            them. A reporter&apos;s optional phone number is visible to staff who triage reports.
          </li>
          <li>
            <strong>Mining operators</strong> see only their own organization&apos;s sites and the
            findings and corrective actions on them. Operators cannot see other operators&apos; data.
          </li>
          <li>
            <strong>Administrators</strong> manage roles and access, and their actions are
            audit-logged.
          </li>
        </UL>
        <P>
          These limits are enforced by the database itself, not only by what the screens display.
          Evidence files are kept in a private store and are opened only through short-lived links
          issued after access is re-checked each time.
        </P>
      </>
    ),
  },
  {
    id: "providers",
    title: "Service providers and third parties",
    body: (
      <>
        <P>
          We use a small number of providers to operate the platform. They process data on our behalf
          or, for map imagery, receive a request from your browser:
        </P>
        <UL>
          <li>
            <strong>Supabase</strong> — database, user authentication and private file storage. Your
            account, records and evidence files are stored there.
          </li>
          <li>
            <strong>GitHub Pages</strong> — serves the app&apos;s pages and code to your browser.
          </li>
          <li>
            <strong>OpenStreetMap</strong> — map tiles. When a map is displayed, your browser requests
            tile images, which reveals your network address and the area you are viewing to the tile
            provider. Map data is © OpenStreetMap contributors.
          </li>
          <li>
            <strong>Email delivery</strong> — the service configured to send account emails such as
            password-reset links.
          </li>
        </UL>
        <P>
          We may disclose information to public authorities with oversight responsibilities, or where
          required by law or to protect people from serious harm. Our providers may host data on
          infrastructure outside Liberia.
        </P>
      </>
    ),
  },
  {
    id: "device",
    title: "Storage on your device",
    body: (
      <>
        <P>
          The platform sets no cookies and uses no advertising or tracking technologies. It stores data
          in your browser so the app can work, including offline (the full, itemised list is in our{" "}
          <Link to="/cookies" className="underline underline-offset-4">
            Cookie Policy
          </Link>
          ):
        </P>
        <UL>
          <li>Your sign-in session, so you stay signed in.</li>
          <li>
            An offline queue: inspections, incidents, observations and evidence files you saved while
            offline, held on your device until they are sent, plus unfinished field drafts.
          </li>
          <li>A cached copy of the app and, only if you allow the map background, a limited number of map tiles you have viewed.</li>
          <li>Small settings, such as pacing of the &quot;install the app&quot; reminder.</li>
        </UL>
        <P>
          Queued items are removed from your device once they are sent or you discard them. Anyone who
          can use your unlocked device could see this stored data, so use a screen lock, sign out on
          shared devices, and clear the site&apos;s data in your browser settings if you stop using a
          device.
        </P>
      </>
    ),
  },
  {
    id: "keep",
    title: "How long we keep information",
    body: (
      <>
        <P>
          Oversight, safety and audit records have to remain reliable, so the platform does not
          permanently delete records through the app. Records move through states instead (for
          example resolved, closed or archived) and corrections are added as new, attributed entries.
          The audit log is append-only.
        </P>
        <P>
          Specific retention periods for evidence, community reports and audit history depend on the
          records law and policy of the institution that adopts the platform, and have not yet been
          set. Until they are, information is kept for as long as it is needed for oversight, audit and
          legal obligations. Data held offline on a device is removed as described in section 6.
        </P>
      </>
    ),
  },
  {
    id: "security",
    title: "How we protect information",
    body: (
      <>
        <UL>
          <li>Role-based and county or operator-based access limits enforced in the database.</li>
          <li>Encrypted connections, and encryption at rest provided by the hosting platform.</li>
          <li>Private evidence storage with temporary, re-checked access links (about two minutes).</li>
          <li>Optional two-factor sign-in, password-reset links that work once, and sign-out of other
            devices after a password change.</li>
          <li>Rate limiting on the public report form, using a salted fingerprint of the network
            address rather than the address itself.</li>
          <li>An audit trail of consequential actions.</li>
        </UL>
        <P>
          No system is perfectly secure. If you believe your account or a report has been exposed,
          please {" "}
          <ContactLine /> straight away.
        </P>
      </>
    ),
  },
  {
    id: "choices",
    title: "Your choices and rights",
    body: (
      <>
        <UL>
          <li>
            <strong>Access and correction.</strong> You can ask what the platform holds about you and
            ask for mistakes to be corrected. Because records are kept for accountability, a
            correction is normally recorded as a new, attributed entry rather than an overwrite.
          </li>
          <li>
            <strong>Deletion or restriction.</strong> You can ask for personal details to be removed
            or limited, for example a phone number you gave in a report. We will do this where we can,
            but we may have to keep information that is needed for oversight, audit or a legal
            obligation.
          </li>
          <li>
            <strong>Optional details.</strong> Contact phone and GPS in a community report are
            optional. You can withhold them, and still track the report with its code.
          </li>
          <li>
            <strong>Device permissions.</strong> You can refuse or withdraw location and camera access
            in your browser or phone settings; the platform keeps working with typed coordinates and
            file upload.
          </li>
        </UL>
        <P>
          To make a request, <ContactLine />. Include your tracking code if the request is about a
          community report. We may need to confirm who you are first, and we will respond within a
          reasonable time.
        </P>
      </>
    ),
  },
  {
    id: "children",
    title: "Children",
    body: (
      <P>
        The platform is for adults who work in or oversee mining, and for members of the public
        reporting concerns. It is not directed at children, and we do not knowingly collect their
        personal information. If you think a child has submitted personal details, please tell us so
        we can review and remove them.
      </P>
    ),
  },
  {
    id: "changes",
    title: "Changes and contact",
    body: (
      <>
        <P>
          We will update this policy when the platform&apos;s data practices change, for example when
          retention periods are set or a new feature collects new information. The version and
          effective date are at the top of this page, and the updated policy replaces the old one
          from its effective date. Using the platform after that date means the updated policy applies.
        </P>
        <P>
          Questions or requests about this policy: <ContactLine />. Our{" "}
          <Link to="/terms" className="underline underline-offset-4">
            Terms of Use
          </Link>{" "}
          explain the rules for using the platform.
        </P>
      </>
    ),
  },
];

export default function Privacy() {
  return (
    <LegalLayout
      kicker="Legal"
      title="Privacy Policy"
      intro={
        <P>
          The short version: you can report a concern without an account or a name; staff and
          operators see only what their role allows; evidence is private; we don&apos;t sell data or
          run advertising or third-party analytics; and records are kept for accountability rather than
          erased.
        </P>
      }
      sections={sections}
      other={{ to: "/terms", label: "Terms of Use" }}
    />
  );
}
