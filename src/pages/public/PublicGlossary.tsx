import { PublicShell } from "@/components/PublicShell";
import { GlossaryBrowser } from "@/components/GlossaryBrowser";

/** Same glossary as the Safety Guidance screen (shared component), English only. */
export default function PublicGlossary() {
  return (
    <PublicShell kicker="Reference" title="Mining glossary" intro="Plain-language definitions of mining terms.">
      <GlossaryBrowser />
    </PublicShell>
  );
}
