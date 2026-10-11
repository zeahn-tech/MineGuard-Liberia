import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import {
  mfaAal,
  mfaListFactors,
  type MfaAal,
  type MfaFactor,
} from "@/lib/supabase";

const LOAD_ERROR = "Could not load your security settings.";

async function readMfaState(): Promise<{ aal: MfaAal; factors: MfaFactor[] }> {
  const [aal, list] = await Promise.all([mfaAal(), mfaListFactors()]);
  return { aal, factors: list.filter((f) => f.status === "verified") };
}

/**
 * The signed-in user's MFA assurance level and verified factors, shared by
 * the staff and operator security pages. `refresh()` re-reads after an
 * enrollment/unenrollment; the initial read ignores results that arrive
 * after the page unmounted.
 */
export function useMfaState() {
  const [loading, setLoading] = useState(true);
  const [aal, setAal] = useState<MfaAal | null>(null);
  const [factors, setFactors] = useState<MfaFactor[]>([]);

  useEffect(() => {
    let cancelled = false;
    readMfaState()
      .then((s) => {
        if (cancelled) return;
        setAal(s.aal);
        setFactors(s.factors);
      })
      .catch((err) => {
        console.error("Security state error:", err);
        if (!cancelled) toast.error(LOAD_ERROR);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const s = await readMfaState();
      setAal(s.aal);
      setFactors(s.factors);
    } catch (err) {
      console.error("Security state error:", err);
      toast.error(LOAD_ERROR);
    } finally {
      setLoading(false);
    }
  }, []);

  return { loading, aal, factors, refresh };
}
