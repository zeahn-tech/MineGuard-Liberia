// Site codes are allocated by the DATABASE (migration 0062); the app never computes one. This file only describes the
// format, so screens and help text can show it and tests can check it against the database's county table.

/** A site code: MGL-<county prefix>-<number, at least 4 digits>, e.g. MGL-BOMI-0001. */
export const SITE_CODE_PATTERN = /^MGL-[A-Z]+-[0-9]{4,}$/;
export const SITE_CODE_EXAMPLE = "MGL-BOMI-0001";

export function isSiteCodeFormat(code: string): boolean {
  return SITE_CODE_PATTERN.test(code.trim());
}

/** Mirror of public.county_codes (0062). Frozen: the first six letters the app always used, so every existing code is valid. */
export const COUNTY_CODE_PREFIXES: Readonly<Record<string, string>> = {
  Bomi: "BOMI",
  Bong: "BONG",
  Gbarpolu: "GBARPO",
  "Grand Bassa": "GRANDB",
  "Grand Cape Mount": "GRANDC",
  "Grand Gedeh": "GRANDG",
  "Grand Kru": "GRANDK",
  Lofa: "LOFA",
  Margibi: "MARGIB",
  Maryland: "MARYLA",
  Montserrado: "MONTSE",
  Nimba: "NIMBA",
  "River Cess": "RIVERC",
  "River Gee": "RIVERG",
  Sinoe: "SINOE",
};

/** The import screen's row message for an unknown site code, with the real format spelled out. Other messages pass through. */
export function importRowMessage(message: string): string {
  return message === "Unknown site code for this company"
    ? `${message}. Site codes look like ${SITE_CODE_EXAMPLE} — copy the code from the site's page.`
    : message;
}
