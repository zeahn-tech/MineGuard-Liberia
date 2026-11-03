// ---------------------------------------------------------------------------
// "DID YOU MEAN" — typo-tolerant suggestions for searches that found nothing.
// Pure and dependency-free. Works on a vocabulary of words that really exist in
// the data being searched, so a suggestion is never a guess that also returns
// nothing.
// ---------------------------------------------------------------------------

/** Optimal-string-alignment distance: insert, delete, substitute, and swap of
 *  two adjacent letters each cost 1 (so "recieve" -> "receive" is 1). */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev2: number[] = new Array(b.length + 1).fill(0);
  let prev: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  let cur: number[] = new Array(b.length + 1).fill(0);
  let older = prev2;
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, older[j - 2] + 1);
      }
      cur[j] = v;
    }
    older = prev;
    prev = cur;
    cur = new Array(b.length + 1).fill(0);
  }
  return prev[b.length];
}

/** Lower-case, strip accents and punctuation, collapse spaces. */
export function normalizeSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** How many edits we tolerate for a word of this length. One- and two-letter
 *  words are never corrected. Three- and four-letter words get one edit, and
 *  only when the first letter matches (typos rarely change it, and it keeps
 *  "dog" from becoming "fog"). */
function allowedEdits(len: number): number {
  if (len <= 2) return 0;
  if (len <= 5) return 1;
  if (len <= 9) return 2;
  return 3;
}

/** Closest word in `vocabulary` to `word`, or null when nothing is close enough. */
export function closestWord(word: string, vocabulary: Iterable<string>): string | null {
  const w = normalizeSearch(word);
  const limit = allowedEdits(w.length);
  if (!w || limit === 0) return null;
  let best: string | null = null;
  let bestD = Infinity;
  for (const cand of vocabulary) {
    if (cand === w) return null; // already a real word: not a typo
    // Cheap rejects before the full computation.
    if (Math.abs(cand.length - w.length) > limit) continue;
    if (w.length <= 4 && cand[0] !== w[0]) continue;
    const d = editDistance(w, cand);
    if (d <= limit && d < bestD) {
      best = cand;
      bestD = d;
    }
  }
  return best;
}

/**
 * Suggest a corrected search phrase, or null when no correction would help.
 * Each word that isn't in the vocabulary is replaced by its closest vocabulary
 * word; words that are fine (or that have no close match) are kept. Returns
 * null unless at least one word changed, so a caller can show "Did you mean …"
 * only when it really has something to offer.
 */
export function suggestQuery(query: string, vocabulary: Iterable<string>): string | null {
  const vocab = new Set<string>();
  for (const v of vocabulary) {
    const n = normalizeSearch(v);
    if (n) for (const part of n.split(" ")) if (part) vocab.add(part);
  }
  const words = normalizeSearch(query).split(" ").filter(Boolean);
  if (!words.length || !vocab.size) return null;
  let changed = false;
  const fixed = words.map((w) => {
    if (vocab.has(w)) return w;
    const c = closestWord(w, vocab);
    if (c) {
      changed = true;
      return c;
    }
    return w;
  });
  return changed ? fixed.join(" ") : null;
}

/** Words of every string, for building a vocabulary from record labels. */
export function vocabularyOf(labels: Iterable<string | null | undefined>): Set<string> {
  const out = new Set<string>();
  for (const l of labels) {
    if (!l) continue;
    for (const part of normalizeSearch(l).split(" ")) if (part.length > 1) out.add(part);
  }
  return out;
}

/**
 * The entry of a fixed list that `value` was most likely meant to be, in the
 * list's own spelling ("grand cpae mount" -> "Grand Cape Mount"), or null when
 * the value already matches an entry or nothing is close. Used for fields with
 * a known set of values (counties) where a typo should be pointed out.
 */
export function suggestFromList(value: string, list: readonly string[]): string | null {
  const typed = normalizeSearch(value);
  if (!typed) return null;
  if (list.some((l) => normalizeSearch(l) === typed)) return null;
  const fixed = suggestQuery(typed, vocabularyOf(list));
  if (!fixed) return null;
  return list.find((l) => normalizeSearch(l) === fixed) ?? null;
}
