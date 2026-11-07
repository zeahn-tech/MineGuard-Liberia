import { api } from "@/lib/backend";
import { useQuery } from "@/lib/backend-react";
import { canWorkCorrectiveActions } from "@/lib/corrective-actions";

/** Whether the signed-in company member may use corrective actions (a site
 *  manager or safety officer of an approved company). The database rule is
 *  the authority; the membership role is only the fallback while that rule is
 *  not deployed yet. */
export function useCaAccess(): "loading" | "allowed" | "denied" {
  const rule = useQuery(api.inspections.canWorkCorrectiveActions);
  const me = useQuery(api.workforce.myMembership);
  if (rule === undefined || me === undefined) return "loading";
  if (rule !== null) return rule ? "allowed" : "denied";
  return canWorkCorrectiveActions(me) ? "allowed" : "denied";
}
