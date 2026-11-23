// Icon for a PPE item. Most items use their emoji; steel-toe boots get a real
// work-boot drawing (high ankle shaft, laces, steel toe cap, lug sole) because
// no emoji depicts a safety boot (the sneaker emoji is misleading).
import type { PpeEntry } from "@/data/safety-reference";

const BOOT_ID = "ref:ppe:steel-toe-safety-boots";

export function SteelToeBootIcon({ className = "size-9" }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" className={className} role="img" aria-label="Steel-toe safety boot" xmlns="http://www.w3.org/2000/svg">
      {/* leather upper */}
      <path d="M9 6 H25 L26.5 19 C27 21 29 22.5 32 23.5 L38 25.5 C42 27 44 30 44 34 V38 H9 Z" fill="#9a6a38" stroke="#4a2f14" strokeWidth="1.4" strokeLinejoin="round" />
      {/* padded collar */}
      <path d="M9 6 H25 L25.3 10 H9 Z" fill="#5c3a1a" stroke="#4a2f14" strokeWidth="1.2" strokeLinejoin="round" />
      {/* tongue / lacing panel */}
      <path d="M14 10.5 H25.2 L26.4 19 C26.8 21 28 22 30 23 L26 24.5 C20 24 16 22 14 19 Z" fill="#b98550" stroke="#4a2f14" strokeWidth="1" strokeLinejoin="round" />
      {/* laces */}
      <g stroke="#2b2b2b" strokeWidth="1.4" strokeLinecap="round">
        <path d="M16 13.5 H23.5" />
        <path d="M16.5 16.5 H24" />
        <path d="M17.5 19.5 H25.5" />
        <path d="M19.5 22.3 H27" />
      </g>
      {/* steel toe cap */}
      <path d="M31.5 24.2 L38 25.5 C42 27 44 30 44 34 V38 H30.5 C31 33 31.5 28 31.5 24.2 Z" fill="#b6c0c9" stroke="#5f6b76" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M34 28 C36.5 28.4 40 30 41 33" fill="none" stroke="#ffffff" strokeWidth="1.5" strokeLinecap="round" opacity="0.85" />
      {/* heel pull loop */}
      <path d="M9 7 C6.5 7 6.5 12 9 12" fill="none" stroke="#4a2f14" strokeWidth="1.4" strokeLinecap="round" />
      {/* lug sole */}
      <path d="M7 38 H45.5 V41 C45.5 42.5 44.5 43.5 43 43.5 H9.5 C8 43.5 7 42.5 7 41 Z" fill="#2b2b2b" />
      <path d="M7 38 H45.5" stroke="#e1b73a" strokeWidth="1.6" />
      <g stroke="#6a6a6a" strokeWidth="1" strokeLinecap="round">
        <path d="M12 41.3 V43" /><path d="M17 41.3 V43" /><path d="M22 41.3 V43" />
        <path d="M27 41.3 V43" /><path d="M32 41.3 V43" /><path d="M37 41.3 V43" /><path d="M42 41.3 V43" />
      </g>
    </svg>
  );
}

export function PpeIcon({ ppe, className }: { ppe: Pick<PpeEntry, "id" | "emoji">; className?: string }) {
  if (ppe.id === BOOT_ID) return <SteelToeBootIcon className={className} />;
  return <span aria-hidden="true">{ppe.emoji}</span>;
}
