// Container for the Ministry licence grace period card (migration 0067): reads the status and wires the save action.
import { LicenceGraceCardView } from "@/components/LicenceGraceCardView";
import { api } from "@/lib/backend";
import { useMutation, useQuery } from "@/lib/backend-react";

export default function LicenceGraceCard() {
  const result = useQuery(api.companies.graceStatus);
  const setGrace = useMutation(api.companies.setGraceUntil);
  return <LicenceGraceCardView result={result} setGrace={setGrace} />;
}
