import { lazy, Suspense, useMemo, useState } from "react";
import { toast } from "sonner";
import type { AdminBoundary, SiteBoundary } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import {
  MAX_IMPORT_BYTES,
  findExistingAdminBoundary,
  matchSiteForCandidate,
  parseBoundaryGeoJson,
  type BoundaryCandidate,
} from "@/lib/gis-import";
import { accuracyProblem } from "@/lib/site-position";

// Leaflet is only needed once someone asks to preview.
const BoundaryPreviewMap = lazy(
  () => import("@/components/BoundaryPreviewMap"),
);

type Kind = "site" | "admin";
type Level = "national" | "region" | "county" | "district" | "community";
const LEVELS: Level[] = [
  "national",
  "region",
  "county",
  "district",
  "community",
];

interface RowEdit {
  include?: boolean;
  siteId?: string;
  name?: string;
}
type RowResult = { ok: boolean; message: string };

const clean = (e: unknown, fallback: string) =>
  e instanceof Error ? e.message.replace(/^[A-Z_]+:\s*/, "") : fallback;

export interface BoundaryLoaderProps {
  sites: ReadonlyArray<{ _id: string; code: string; name: string }>;
  adminBoundaries: ReadonlyArray<AdminBoundary>;
  siteBoundaries: ReadonlyArray<SiteBoundary>;
  /** false while the already-loaded lists are still being fetched. */
  loaded: boolean;
  saveSite: (args: {
    siteId: string;
    geometryGeoJson: string;
    source: string;
    accuracyM?: number;
    geoVerified?: boolean;
  }) => Promise<unknown>;
  saveAdmin: (args: {
    id?: string;
    name: string;
    level: Level;
    geometryGeoJson: string;
    source: string;
    accuracyM?: number;
    geoVerified?: boolean;
  }) => Promise<unknown>;
}

/** Review-and-load flow for GeoJSON boundaries. Presentational: the page
 *  supplies data and the two save functions, so the whole flow is testable
 *  without the data layer. */
export function BoundaryLoader({
  sites: siteList,
  adminBoundaries,
  siteBoundaries,
  loaded,
  saveSite,
  saveAdmin,
}: BoundaryLoaderProps) {
  const [kind, setKind] = useState<Kind>("site");
  const [text, setText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [rows, setRows] = useState<Record<number, RowEdit>>({});
  const [results, setResults] = useState<Record<number, RowResult>>({});
  const [level, setLevel] = useState<Level>("county");
  const [source, setSource] = useState("");
  const [accuracy, setAccuracy] = useState("");
  const [verified, setVerified] = useState(false);
  const [running, setRunning] = useState(false);
  const [preview, setPreview] = useState(false);

  const parsed = useMemo(() => parseBoundaryGeoJson(text), [text]);

  // ---- per-row state, derived (defaults come from the file + the site list)
  const rowOf = (c: BoundaryCandidate) => {
    const e = rows[c.index] ?? {};
    return {
      include: e.include ?? !c.problem,
      siteId: e.siteId ?? matchSiteForCandidate(c, siteList),
      name: e.name ?? c.name ?? "",
    };
  };
  const edit = (index: number, patch: RowEdit) => {
    setRows((r) => ({ ...r, [index]: { ...r[index], ...patch } }));
    setResults({});
  };
  const resetInput = (nextText: string, nextName: string | null) => {
    setText(nextText);
    setFileName(nextName);
    setRows({});
    setResults({});
    setPreview(false);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      setFileError(
        `${file.name} is larger than ${Math.round(MAX_IMPORT_BYTES / 1_000_000)} MB. Split it into smaller files (for example one per county).`,
      );
      return;
    }
    setFileError(null);
    resetInput(await file.text(), file.name);
  };

  // ---- what would be loaded, and what stops it
  const ready = parsed.candidates.filter((c) => !c.problem);
  const planned = ready
    .map((c) => ({ c, row: rowOf(c) }))
    .filter(({ row }) => row.include);
  const accuracyNum = accuracy.trim() === "" ? undefined : Number(accuracy);

  const blockers: string[] = [];
  if (planned.length === 0)
    blockers.push("Select at least one valid shape to load.");
  if (!source.trim())
    blockers.push("Say where this data came from (the source).");
  if (accuracyNum !== undefined && accuracyProblem(accuracyNum))
    blockers.push("Accuracy must be a number of metres, 0 or more.");
  if (kind === "site") {
    if (planned.some(({ row }) => !row.siteId))
      blockers.push("Choose the site for every selected shape.");
    const ids = planned.map(({ row }) => row.siteId).filter(Boolean);
    if (new Set(ids).size !== ids.length)
      blockers.push(
        "Two selected shapes point at the same site — a site has one outline.",
      );
  } else {
    if (planned.some(({ row }) => !row.name.trim()))
      blockers.push("Give every selected shape a name.");
    const keys = planned.map(
      ({ row }) => `${level}:${row.name.trim().toLowerCase()}`,
    );
    if (new Set(keys).size !== keys.length)
      blockers.push("Two selected shapes have the same name at this level.");
  }

  const run = async () => {
    if (running || blockers.length > 0) return;
    setRunning(true);
    let out: Record<number, RowResult> = {};
    setResults(out);
    for (const { c, row } of planned) {
      try {
        const common = {
          geometryGeoJson: c.geometryGeoJson as string,
          source: source.trim(),
          accuracyM: accuracyNum,
          geoVerified: verified,
        };
        if (kind === "site") {
          const had = siteBoundaries.some((b) => b.siteId === row.siteId);
          await saveSite({ siteId: row.siteId as string, ...common });
          out = {
            ...out,
            [c.index]: {
              ok: true,
              message: had ? "Replaced the previous outline" : "Outline saved",
            },
          };
        } else {
          const existingId = findExistingAdminBoundary(
            row.name,
            level,
            adminBoundaries,
          );
          await saveAdmin({
            id: existingId,
            name: row.name.trim(),
            level,
            ...common,
          });
          out = {
            ...out,
            [c.index]: {
              ok: true,
              message: existingId
                ? "Replaced the existing boundary"
                : "Boundary created",
            },
          };
        }
      } catch (e) {
        out = { ...out, [c.index]: { ok: false, message: clean(e, "Failed") } };
      }
      setResults(out);
    }
    setRunning(false);
    const okCount = Object.values(out).filter((r) => r.ok).length;
    const failed = planned.length - okCount;
    if (failed === 0)
      toast.success(
        `Loaded ${okCount} boundar${okCount === 1 ? "y" : "ies"} — see them on the National Map`,
      );
    else
      toast.error(`${okCount} loaded, ${failed} failed — see the rows below`);
  };

  const previewShapes = planned.map(({ c }) => ({
    id: String(c.index),
    label: c.label,
    geometryGeoJson: c.geometryGeoJson as string,
  }));
  const problems = parsed.candidates.length - ready.length;

  return (
    <div className="min-w-0 space-y-8">
      <Tabs
        value={kind}
        onValueChange={(v) => {
          setKind(v as Kind);
          setRows({});
          setResults({});
        }}
      >
        <TabsList className="h-auto max-w-full flex-wrap justify-start">
          <TabsTrigger value="site">Site outlines</TabsTrigger>
          <TabsTrigger value="admin">Administrative areas</TabsTrigger>
        </TabsList>

        {/* The panel the active tab controls (aria-controls must resolve). */}
        <TabsContent value={kind} className="min-w-0 space-y-8 pt-8 outline-none">
          <DataSourcesHelp />

          {/* 1 — the data */}
          <section className="min-w-0 space-y-3">
            <h2 className="display border-b border-border pb-2 text-lg">
              1 · Choose the GeoJSON
            </h2>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="boundary-file">
                GeoJSON file (.geojson or .json, up to 5 MB)
              </Label>
              <Input
                id="boundary-file"
                type="file"
                accept=".geojson,.json,application/geo+json,application/json"
                onChange={(e) => void onFile(e.target.files?.[0])}
                disabled={running}
              />
              {fileName && (
                <p className="text-xs break-all text-muted-foreground">
                  Loaded {fileName}
                </p>
              )}
              {fileError && (
                <p className="text-xs break-words text-destructive" role="alert">
                  {fileError}
                </p>
              )}
            </div>
            <div className="min-w-0 space-y-1.5">
              <Label htmlFor="boundary-text">…or paste GeoJSON</Label>
              <Textarea
                id="boundary-text"
                value={text}
                onChange={(e) => resetInput(e.target.value, null)}
                rows={4}
                className="w-full max-w-full font-mono text-xs"
                placeholder='{"type":"FeatureCollection","features":[…]}'
                disabled={running}
              />
              <p className="text-[11px] break-words text-muted-foreground">
                Coordinates must be WGS84 [longitude, latitude] — Liberia&apos;s
                longitudes are negative. Shapefile, KML and TopoJSON are not
                read; export as GeoJSON first.
              </p>
            </div>
            {parsed.fatal && (
              <p className="text-sm break-words text-destructive" role="alert">
                {parsed.fatal}
              </p>
            )}
          </section>

          {/* 2 — review */}
          {parsed.candidates.length > 0 && (
            <section className="min-w-0 space-y-3">
              <h2 className="display border-b border-border pb-2 text-lg">
                2 · Review
              </h2>
              <p className="text-sm break-words text-muted-foreground" role="status">
                Found {parsed.candidates.length} shape
                {parsed.candidates.length === 1 ? "" : "s"}:{" "}
                <strong>{ready.length}</strong> valid
                {problems > 0 && (
                  <>
                    , <strong className="text-destructive">{problems}</strong>{" "}
                    with problems (not loaded)
                  </>
                )}
                .
              </p>

              {kind === "admin" && (
                <div className="flex flex-wrap items-center gap-2">
                  <Label htmlFor="boundary-level" className="text-sm">
                    These are
                  </Label>
                  <Select
                    value={level}
                    onValueChange={(v) => {
                      setLevel(v as Level);
                      setResults({});
                    }}
                  >
                    <SelectTrigger id="boundary-level" className="w-40">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {LEVELS.map((l) => (
                        <SelectItem key={l} value={l}>
                          {l}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <span className="text-xs text-muted-foreground">
                    boundaries
                  </span>
                </div>
              )}

              <ul className="min-w-0 divide-y divide-border border border-border">
                {parsed.candidates.map((c) => {
                  const row = rowOf(c);
                  const result = results[c.index];
                  const existing =
                    kind === "admin" && row.name.trim()
                      ? findExistingAdminBoundary(
                          row.name,
                          level,
                          adminBoundaries,
                        )
                      : undefined;
                  return (
                    <li key={c.index} className="min-w-0 space-y-2 p-3">
                      <div className="flex min-w-0 flex-wrap items-start gap-x-3 gap-y-1 sm:flex-nowrap">
                        <Checkbox
                          checked={row.include && !c.problem}
                          disabled={Boolean(c.problem) || running}
                          onCheckedChange={(v) =>
                            edit(c.index, { include: v === true })
                          }
                          aria-label={`Load ${c.label}`}
                          className="mt-1"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-sm font-medium break-words">{c.label}</p>
                          {c.problem ? (
                            <p className="mt-0.5 text-xs break-words text-destructive">
                              {c.problem}
                            </p>
                          ) : (
                            <p className="mt-0.5 text-xs break-words text-muted-foreground">
                              {c.geometryType}
                              {c.parts > 1 ? ` · ${c.parts} parts` : ""} ·{" "}
                              {c.vertices.toLocaleString()} points
                            </p>
                          )}
                        </div>
                        {result && (
                          <span
                            className={`min-w-0 max-w-full break-words pl-7 text-xs sm:max-w-[45%] sm:pl-0 sm:text-right ${result.ok ? "text-muted-foreground" : "text-destructive"}`}
                            role="status"
                          >
                            {result.ok ? "✓ " : "✕ "}
                            {result.message}
                          </span>
                        )}
                      </div>

                      {!c.problem && row.include && kind === "site" && (
                        <div className="min-w-0 pl-7">
                          <Select
                            value={row.siteId ?? ""}
                            onValueChange={(v) => edit(c.index, { siteId: v })}
                            disabled={running}
                          >
                            <SelectTrigger aria-label={`Site for ${c.label}`}>
                              <SelectValue placeholder="Which site is this outline for?" />
                            </SelectTrigger>
                            <SelectContent>
                              {siteList.map((s) => (
                                <SelectItem key={s._id} value={s._id}>
                                  {s.code} — {s.name}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}

                      {!c.problem && row.include && kind === "admin" && (
                        <div className="min-w-0 space-y-1 pl-7">
                          <Input
                            value={row.name}
                            onChange={(e) =>
                              edit(c.index, { name: e.target.value })
                            }
                            placeholder="Name of the area"
                            aria-label={`Name for ${c.label}`}
                            disabled={running}
                          />
                          {existing && (
                            <p className="text-[11px] break-words text-muted-foreground">
                              A {level} named “{row.name.trim()}” is already
                              loaded — this will replace it.
                            </p>
                          )}
                        </div>
                      )}
                    </li>
                  );
                })}
              </ul>

              {planned.length > 0 && (
                <div className="min-w-0 space-y-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setPreview((v) => !v)}
                    aria-expanded={preview}
                  >
                    {preview ? "Hide preview" : "Preview on map"}
                  </Button>
                  {preview && (
                    <Suspense
                      fallback={
                        <p className="py-6 text-center text-xs text-muted-foreground">
                          Loading map…
                        </p>
                      }
                    >
                      <BoundaryPreviewMap
                        shapes={previewShapes}
                        kind={
                          kind === "site"
                            ? "site_boundaries"
                            : "admin_boundaries"
                        }
                      />
                    </Suspense>
                  )}
                </div>
              )}
            </section>
          )}

          {/* 3 — provenance + load */}
          {parsed.candidates.length > 0 && (
            <section className="min-w-0 space-y-3">
              <h2 className="display border-b border-border pb-2 text-lg">
                3 · Source and load
              </h2>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="boundary-source">
                  Source of this data (required)
                </Label>
                <Input
                  id="boundary-source"
                  value={source}
                  onChange={(e) => {
                    setSource(e.target.value);
                    setResults({});
                  }}
                  placeholder="e.g. Liberia Land Authority county boundaries, 2024"
                  disabled={running}
                />
              </div>
              <div className="min-w-0 space-y-1.5">
                <Label htmlFor="boundary-accuracy">
                  Positional accuracy in metres (optional)
                </Label>
                <Input
                  id="boundary-accuracy"
                  value={accuracy}
                  onChange={(e) => setAccuracy(e.target.value)}
                  inputMode="decimal"
                  className="w-40"
                  disabled={running}
                />
              </div>
              <div className="flex items-start gap-2">
                <Checkbox
                  id="boundary-verified"
                  checked={verified}
                  onCheckedChange={(v) => setVerified(v === true)}
                  disabled={running}
                />
                <Label
                  htmlFor="boundary-verified"
                  className="text-sm font-normal leading-snug"
                >
                  Mark as verified — the source above is authoritative. Leave
                  unticked if unsure: the map then draws these as unverified.
                </Label>
              </div>

              {blockers.length > 0 && (
                <ul
                  className="space-y-0.5 text-xs break-words text-muted-foreground"
                  aria-live="polite"
                >
                  {blockers.map((b) => (
                    <li key={b}>• {b}</li>
                  ))}
                </ul>
              )}
              <Button
                onClick={() => void run()}
                disabled={running || blockers.length > 0}
              >
                {running
                  ? "Loading…"
                  : `Load ${planned.length} boundar${planned.length === 1 ? "y" : "ies"}`}
              </Button>
            </section>
          )}

          {/* what is already loaded */}
          <section className="min-w-0 space-y-3">
            <h2 className="display border-b border-border pb-2 text-lg">
              Already loaded
            </h2>
            {!loaded ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : adminBoundaries.length === 0 && siteBoundaries.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No boundaries are loaded yet, so the boundary layers on the
                National Map are empty.
              </p>
            ) : (
              <div className="grid min-w-0 grid-cols-1 gap-6 md:grid-cols-2">
                <LoadedList
                  emptyText="No administrative areas loaded yet."
                  title={`Administrative areas (${adminBoundaries.length})`}
                  items={adminBoundaries.map((b) => ({
                    key: b._id,
                    primary: b.name,
                    secondary: `${b.level} · ${b.source}`,
                    verified: b.geoVerified,
                  }))}
                />
                <LoadedList
                  emptyText="No site outlines loaded yet. Site outlines have no public source: load a surveyed or licence-boundary GeoJSON using the Site outlines tab above."
                  title={`Site outlines (${siteBoundaries.length})`}
                  items={siteBoundaries.map((b) => {
                    const site = siteList.find((s) => s._id === b.siteId);
                    return {
                      key: b._id,
                      primary: site ? `${site.code} — ${site.name}` : b.siteId,
                      secondary: b.source,
                      verified: b.geoVerified,
                    };
                  })}
                />
              </div>
            )}
          </section>
        </TabsContent>
      </Tabs>
    </div>
  );
}

const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;

/** Where boundary data comes from, and how to get it into GeoJSON. */
function DataSourcesHelp() {
  const link = "underline underline-offset-2";
  return (
    <details className="paper group min-w-0 p-4 text-sm">
      <summary className="cursor-pointer font-medium">
        Where do I get this data?
      </summary>
      <div className="mt-3 min-w-0 space-y-4 text-xs leading-relaxed break-words text-muted-foreground">
        <section>
          <h3 className="text-sm font-medium text-foreground">
            Counties and districts (administrative areas)
          </h3>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li>
              <a
                className={link}
                href="https://www.geoboundaries.org/"
                {...EXTERNAL}
              >
                geoBoundaries
              </a>{" "}
              — open data, but the licence is set <strong>per boundary</strong>:
              check each dataset&apos;s <code>boundaryLicense</code> and{" "}
              <code>boundarySource</code> on its geoBoundaries page and credit
              them in the Source field. Choose Liberia: ADM1 = counties, ADM2 =
              districts. GeoJSON downloads directly; use the simplified file if
              the full one is over 5 MB.
            </li>
            <li>
              <a
                className={link}
                href="https://data.humdata.org/dataset/cod-ab-lbr"
                {...EXTERNAL}
              >
                OCHA / HDX — Liberia Subnational Administrative Boundaries
              </a>{" "}
              — a shapefile (.zip) covering counties and districts; convert it
              as below. Source UNMIL / OCHA ROWCA; licence CC BY 3.0 IGO (credit
              the source, say if you changed it, and do not imply their
              endorsement).
            </li>
          </ul>
        </section>
        <section>
          <h3 className="text-sm font-medium text-foreground">Site outlines</h3>
          <p className="mt-1">
            There is no public source for individual site outlines. They come
            from your own survey (a GPS track, or traced in QGIS), or from the
            concession / permit boundary supplied by the licensing authority or
            the operator. Save the result as GeoJSON.
          </p>
        </section>
        <section>
          <h3 className="text-sm font-medium text-foreground">
            Converting a Shapefile, KML or TopoJSON to GeoJSON
          </h3>
          <ul className="mt-1 list-disc space-y-1 pl-4">
            <li>
              <a className={link} href="https://mapshaper.org/" {...EXTERNAL}>
                mapshaper.org
              </a>{" "}
              (free, runs in your browser): drop in the .zip (or the .shp, .dbf
              and .prj files together) or the KML/TopoJSON file, then Export →
              GeoJSON. If the data is not in degrees, type{" "}
              <code>-proj wgs84</code> in its console first. Its Simplify slider
              shrinks big files.
            </li>
            <li>
              <a className={link} href="https://qgis.org/" {...EXTERNAL}>
                QGIS
              </a>{" "}
              (free): right-click the layer → Export → Save Features As… →
              format GeoJSON, CRS EPSG:4326.
            </li>
            <li>
              Command line:{" "}
              <code className="break-all">
                ogr2ogr -f GeoJSON -t_srs EPSG:4326 out.geojson in.shp
              </code>
            </li>
          </ul>
          <p className="mt-1">
            The file must be WGS84 longitude/latitude (EPSG:4326) — this page
            tells you if it is not.
          </p>
        </section>
      </div>
    </details>
  );
}

function LoadedList({
  title,
  items,
  emptyText = "None.",
}: {
  title: string;
  emptyText?: string;
  items: {
    key: string;
    primary: string;
    secondary: string;
    verified: boolean;
  }[];
}) {
  return (
    <div className="min-w-0">
      <h3 className="text-sm font-medium break-words">{title}</h3>
      {items.length === 0 ? (
        <p className="mt-1 text-xs break-words text-muted-foreground">{emptyText}</p>
      ) : (
        <ul className="mt-1 min-w-0 divide-y divide-border border border-border text-sm">
          {items.map((i) => (
            <li
              key={i.key}
              className="flex items-start justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0">
                <p className="truncate font-medium">{i.primary}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {i.secondary}
                </p>
              </div>
              <span className="stamp shrink-0">
                {i.verified ? "verified" : "unverified"}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
