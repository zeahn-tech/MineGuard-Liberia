// ---------------------------------------------------------------------------
// RISK MODEL (RSK-1) — the weights behind every risk indicator.
//
// * Everyone with staff access can SEE the configuration in force, every
//   published version and what changed between them.
// * Only administrators can publish a new version. Versions are append-only
//   and effective-dated: "editing" means publishing the next version, which
//   the database numbers, signs and audits. Nothing here can alter or delete
//   a past version.
// * The page reads the database's config through api.riskConfig — it holds no
//   weights of its own (the editor starts from the latest published version).
// ---------------------------------------------------------------------------

import { useMemo, useState } from "react";
import { History, ShieldAlert } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/backend";
import { useMutation, useQuery } from "@/lib/backend-react";
import { useAuth } from "@/hooks/use-auth";
import { useNow } from "@/hooks/use-now";
import { StaffOnly } from "@/components/StaffOnly";
import {
  MAX_LOOKBACK_DAYS,
  MAX_WEIGHT,
  MIN_LOOKBACK_DAYS,
  RISK_WEIGHT_KEYS,
  RISK_WEIGHT_LABELS,
  diffRiskSettings,
  validateRiskSettings,
  versionHistory,
  versionInForce,
  type RiskConfigVersion,
  type RiskWeights,
} from "@/lib/risk-config";

const fmt = (ms: number) => (ms <= 0 ? "since launch" : new Date(ms).toLocaleString());

export default function RiskConfig() {
  const { user } = useAuth();
  const versions = useQuery(api.riskConfig.list);
  const isAdmin = user?.role === "admin";

  return (
    <StaffOnly>
      <div className="space-y-8">
        <header>
          <p className="kicker">Administration</p>
          <h1 className="display mt-1 text-3xl">Risk model</h1>
          <p className="mt-2 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            The weights behind every site risk indicator. A score is the sum of its factors and is
            decision support only — it never determines guilt or triggers enforcement. Each change
            is a new, dated version; earlier versions are kept so any score can be reproduced.
          </p>
        </header>

        {versions === undefined ? (
          <p className="py-16 text-center text-sm text-muted-foreground">Loading…</p>
        ) : versions.length === 0 ? (
          <div className="paper p-6 text-sm text-muted-foreground">
            No risk configuration is published in this deployment yet (migration 0019 not applied).
          </div>
        ) : (
          <Loaded versions={versions} isAdmin={isAdmin} />
        )}
      </div>
    </StaffOnly>
  );
}

function Loaded({ versions, isAdmin }: { versions: RiskConfigVersion[]; isAdmin: boolean }) {
  const now = useNow();
  const inForce = versionInForce(versions, now);
  const latest = versions.reduce((a, b) => (b.version > a.version ? b : a), versions[0]);
  const history = useMemo(() => versionHistory(versions), [versions]);

  return (
    <>
      {inForce && <ActiveConfig version={inForce} upcoming={versions.filter((v) => v.effectiveFrom > now)} />}
      {isAdmin ? (
        <PublishForm latest={latest} now={now} />
      ) : (
        <p className="flex items-start gap-2 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} />
          Publishing a new version is limited to administrators.
        </p>
      )}
      <ScoresByVersion versions={versions} />
      <HistoryList history={history} now={now} />
    </>
  );
}

function ActiveConfig({
  version,
  upcoming,
}: {
  version: RiskConfigVersion;
  upcoming: RiskConfigVersion[];
}) {
  return (
    <section className="paper p-5" aria-labelledby="active-config">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 id="active-config" className="display text-lg">
          In force now: version {version.version}
        </h2>
        <span className="text-xs text-muted-foreground">effective {fmt(version.effectiveFrom)}</span>
      </div>
      <dl className="mt-4 grid gap-x-8 gap-y-2 sm:grid-cols-2">
        {RISK_WEIGHT_KEYS.map((k) => (
          <div key={k} className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5">
            <dt className="text-sm">{RISK_WEIGHT_LABELS[k]}</dt>
            <dd className="font-mono text-sm tabular-nums">{version.weights[k]}</dd>
          </div>
        ))}
        <div className="flex items-baseline justify-between gap-3 border-b border-border/60 py-1.5">
          <dt className="text-sm">Historical look-back (days)</dt>
          <dd className="font-mono text-sm tabular-nums">{version.lookbackDays}</dd>
        </div>
      </dl>
      {version.weights.lateClosedCA === 0 && (
        <p className="mt-3 text-xs text-muted-foreground">
          Historical compliance is switched off (weight 0): late-closed corrective actions do not
          change any score in this version.
        </p>
      )}
      {upcoming.length > 0 && (
        <p className="mt-3 text-xs text-primary">
          Scheduled: version {upcoming.map((u) => `${u.version} (from ${fmt(u.effectiveFrom)})`).join(", ")}.
        </p>
      )}
    </section>
  );
}

function PublishForm({ latest, now }: { latest: RiskConfigVersion; now: number }) {
  const publish = useMutation(api.riskConfig.publish);
  const [weights, setWeights] = useState<Record<string, string>>(() =>
    Object.fromEntries(RISK_WEIGHT_KEYS.map((k) => [k, String(latest.weights[k])])),
  );
  const [lookback, setLookback] = useState(String(latest.lookbackDays));
  const [note, setNote] = useState("");
  const [effective, setEffective] = useState(""); // blank = immediately
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => {
    const w = {} as RiskWeights;
    for (const k of RISK_WEIGHT_KEYS) w[k] = weights[k] === "" ? NaN : Number(weights[k]);
    return { weights: w, lookbackDays: lookback === "" ? NaN : Number(lookback) };
  }, [weights, lookback]);

  const problem = validateRiskSettings(parsed);
  const changes = problem ? [] : diffRiskSettings(latest, parsed);
  const effectiveMs = effective ? new Date(effective).getTime() : undefined;
  const dateProblem =
    effectiveMs !== undefined && (Number.isNaN(effectiveMs) || effectiveMs < now)
      ? "The effective date cannot be in the past."
      : effectiveMs !== undefined && effectiveMs <= latest.effectiveFrom
        ? "It must be after the latest version’s effective date."
        : null;
  const noteProblem = note.trim().length < 3 ? "A change note is required." : null;
  const canPublish = !problem && !dateProblem && !noteProblem && changes.length > 0 && !busy;

  async function onPublish() {
    setBusy(true);
    try {
      const v = await publish({
        weights: parsed.weights,
        lookbackDays: parsed.lookbackDays,
        changeNote: note,
        effectiveFrom: effectiveMs,
      });
      toast.success(`Published version ${v.version}`);
      setNote("");
      setEffective("");
    } catch (e) {
      toast.error(e instanceof Error ? e.message.replace(/^[A-Z_]+:\s*/, "") : "Could not publish");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="paper p-5" aria-labelledby="publish-config">
      <h2 id="publish-config" className="display text-lg">
        Publish a new version
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Starts from version {latest.version}. Whole numbers from 0 to {MAX_WEIGHT}. Setting a weight
        to 0 switches that factor off.
      </p>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {RISK_WEIGHT_KEYS.map((k) => (
          <label key={k} className="flex items-center justify-between gap-3 text-sm">
            <span>{RISK_WEIGHT_LABELS[k]}</span>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={MAX_WEIGHT}
              step={1}
              value={weights[k]}
              onChange={(e) => setWeights((w) => ({ ...w, [k]: e.target.value }))}
              className="w-24 rounded-sm border border-border bg-background px-2 py-1 text-right font-mono text-sm"
              aria-label={RISK_WEIGHT_LABELS[k]}
            />
          </label>
        ))}
        <label className="flex items-center justify-between gap-3 text-sm">
          <span>Historical look-back (days)</span>
          <input
            type="number"
            inputMode="numeric"
            min={MIN_LOOKBACK_DAYS}
            max={MAX_LOOKBACK_DAYS}
            step={1}
            value={lookback}
            onChange={(e) => setLookback(e.target.value)}
            className="w-24 rounded-sm border border-border bg-background px-2 py-1 text-right font-mono text-sm"
            aria-label="Historical look-back (days)"
          />
        </label>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <label className="block text-sm">
          <span className="text-xs text-muted-foreground">Change note (required)</span>
          <input
            type="text"
            value={note}
            maxLength={500}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Why this change?"
            className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm"
          />
        </label>
        <label className="block text-sm">
          <span className="text-xs text-muted-foreground">Effective from (blank = immediately)</span>
          <input
            type="datetime-local"
            value={effective}
            onChange={(e) => setEffective(e.target.value)}
            className="mt-1 w-full rounded-sm border border-border bg-background px-2 py-1.5 text-sm"
          />
        </label>
      </div>

      <div className="mt-4" aria-live="polite">
        {problem ? (
          <p className="text-xs text-destructive">{problem}</p>
        ) : dateProblem ? (
          <p className="text-xs text-destructive">{dateProblem}</p>
        ) : changes.length === 0 ? (
          <p className="text-xs text-muted-foreground">No changes from version {latest.version}.</p>
        ) : (
          <>
            <p className="text-xs font-medium">This will change:</p>
            <ChangeList changes={changes} />
          </>
        )}
      </div>

      <div className="mt-4 flex items-center gap-3">
        <button
          type="button"
          onClick={onPublish}
          disabled={!canPublish}
          className="rounded-sm bg-primary px-4 py-2 text-sm font-medium text-primary-foreground disabled:opacity-40"
        >
          {busy ? "Publishing…" : "Publish version"}
        </button>
        {noteProblem && changes.length > 0 && !problem && (
          <span className="text-xs text-muted-foreground">{noteProblem}</span>
        )}
      </div>
      <p className="mt-3 text-xs text-muted-foreground">
        Published versions cannot be edited or removed. Every publication is recorded in the audit
        log with your name.
      </p>
    </section>
  );
}

function ChangeList({
  changes,
}: {
  changes: { key: string; label: string; from: number; to: number }[];
}) {
  return (
    <ul className="mt-1 space-y-0.5">
      {changes.map((c) => (
        <li key={c.key} className="flex flex-wrap items-baseline gap-x-2 text-sm">
          <span>{c.label}</span>
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {c.from} → <span className="text-foreground">{c.to}</span>
            <span className={c.to > c.from ? " text-destructive" : " text-primary"}>
              {" "}
              ({c.to > c.from ? "+" : "−"}
              {Math.abs(c.to - c.from)})
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

function HistoryList({
  history,
  now,
}: {
  history: ReturnType<typeof versionHistory>;
  now: number;
}) {
  return (
    <section aria-labelledby="risk-history">
      <h2 id="risk-history" className="display flex items-center gap-2 text-lg">
        <History className="size-4" strokeWidth={1.5} />
        Version history
      </h2>
      <ol className="mt-3 space-y-3">
        {history.map(({ version, changes }) => (
          <li key={version.id} className="paper p-4">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-medium">Version {version.version}</span>
              <span className="text-xs text-muted-foreground">
                effective {fmt(version.effectiveFrom)}
                {version.effectiveFrom > now ? " (scheduled)" : ""}
              </span>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{version.changeNote}</p>
            <div className="mt-2">
              {changes === null ? (
                <p className="text-xs text-muted-foreground">Initial configuration.</p>
              ) : changes.length === 0 ? (
                <p className="text-xs text-muted-foreground">No weight changes.</p>
              ) : (
                <ChangeList changes={changes} />
              )}
            </div>
            <p className="mt-2 text-[11px] text-muted-foreground">
              Published {new Date(version.createdAt).toLocaleString()}
              {version.createdBy ? "" : " · system"}
            </p>
          </li>
        ))}
      </ol>
    </section>
  );
}

/** Reproduce scores under any published version — the same server computation,
 *  pinned to that version. */
function ScoresByVersion({ versions }: { versions: RiskConfigVersion[] }) {
  const [selected, setSelected] = useState<number | null>(null);
  const sites = useQuery(api.sites.list);
  const scores = useQuery(api.sites.riskScores, selected === null ? "skip" : { version: selected });
  const names = useMemo(
    () => Object.fromEntries((sites ?? []).map((s) => [s._id, `${s.code} · ${s.name}`])),
    [sites],
  );
  const rows = useMemo(
    () =>
      Object.entries(scores ?? {})
        .map(([id, r]) => ({ id, score: r.score, name: names[id] ?? id }))
        .sort((a, b) => b.score - a.score)
        .slice(0, 10),
    [scores, names],
  );
  const ordered = [...versions].sort((a, b) => b.version - a.version);

  return (
    <section className="paper p-5" aria-labelledby="scores-by-version">
      <h2 id="scores-by-version" className="display text-lg">
        Scores under a version
      </h2>
      <p className="mt-1 text-xs text-muted-foreground">
        Recompute the current records under any published version — the same server-side
        computation, pinned to that version.
      </p>
      <label className="mt-3 flex items-center gap-3 text-sm">
        <span>Version</span>
        <select
          value={selected ?? ""}
          onChange={(e) => setSelected(e.target.value === "" ? null : Number(e.target.value))}
          className="rounded-sm border border-border bg-background px-2 py-1 text-sm"
        >
          <option value="">Choose…</option>
          {ordered.map((v) => (
            <option key={v.id} value={v.version}>
              Version {v.version}
            </option>
          ))}
        </select>
      </label>
      {selected !== null &&
        (scores === undefined ? (
          <p className="mt-3 text-xs text-muted-foreground">Computing…</p>
        ) : rows.length === 0 ? (
          <p className="mt-3 text-xs text-muted-foreground">No sites in your scope.</p>
        ) : (
          <ol className="mt-3 divide-y divide-border">
            {rows.map((r) => (
              <li key={r.id} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
                <span className="truncate">{r.name}</span>
                <span className="font-mono tabular-nums">{r.score}</span>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}
