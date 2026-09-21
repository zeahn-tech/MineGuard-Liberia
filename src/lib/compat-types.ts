// ---------------------------------------------------------------------------
// TYPE COMPATIBILITY SHIMS
//
// The codebase was migrated from Convex to Firebase. Convex branded `Id<T>`
// types are now plain strings (Firestore document IDs), and `Doc<T>` maps to
// the corresponding domain interface in @/lib/types.
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

// Convex `Id<"collection">` — now just a Firestore document ID string.
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

// Convex `Doc<"collection">` — maps to the domain interface.
export type Doc<T extends keyof DocMap> = DocMap[T];
