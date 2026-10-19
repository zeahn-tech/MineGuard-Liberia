// ---------------------------------------------------------------------------
// ENTITY TYPE ALIASES
//
// `Id<T>` is the Postgres uuid primary key as a plain string; `Doc<T>` maps a
// collection name to its domain interface in ./types.
// ---------------------------------------------------------------------------

import type {
  CommunityReport,
  CorrectiveAction,
  EnvironmentalObservation,
  Evidence,
  Finding,
  Incident,
  Inspection,
  InspectionTemplate,
  Site,
  UserProfile,
} from "./types";

// `Id<"collection">` — the row's uuid primary key, as a string.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
export type Id<T extends string> = string;

export interface DocMap {
  users: UserProfile;
  sites: Site;
  inspectionTemplates: InspectionTemplate;
  inspections: Inspection;
  findings: Finding;
  correctiveActions: CorrectiveAction;
  incidents: Incident;
  environmentalObservations: EnvironmentalObservation;
  communityReports: CommunityReport;
  evidence: Evidence;
}

// `Doc<"collection">` — the domain interface for that collection.
export type Doc<T extends keyof DocMap> = DocMap[T];
