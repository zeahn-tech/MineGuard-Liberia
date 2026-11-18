// VAPID key validation: catches the "private key should be 32 bytes" failure before web-push does, and never
// leaks key material into its diagnostics.
import { describe, expect, test } from "bun:test";
import { createECDH, randomBytes } from "node:crypto";
import { checkVapidKeys, describeVapidProblem, normalizeVapidKey, resolveVapidConfig } from "../supabase/functions/_shared/push/vapid";

function pair() {
  const e = createECDH("prime256v1");
  e.generateKeys();
  return { pub: e.getPublicKey().toString("base64url"), priv: e.getPrivateKey().toString("base64url").padStart(43, "A") };
}
const SUBJECT = "mailto:ops@example.test";

describe("vapid key validation", () => {
  test("a valid pair passes", () => {
    const { pub, priv } = pair();
    expect(checkVapidKeys(pub, priv)).toBeNull();
    const r = resolveVapidConfig({ subject: SUBJECT, publicKey: pub, privateKey: priv });
    expect(r.ok).toBe(true);
  });

  test("whitespace, quotes, padding and standard-base64 characters are normalised away", () => {
    const { pub, priv } = pair();
    const std = Buffer.from(priv, "base64url").toString("base64"); // has "=" padding, may contain + /
    expect(normalizeVapidKey(` "${priv}"\n`)).toBe(priv);
    expect(normalizeVapidKey(std)).toBe(priv);
    expect(checkVapidKeys(`${pub}\r\n`, `'${std}'\n`)).toBeNull();
    const r = resolveVapidConfig({ subject: ` ${SUBJECT} `, publicKey: pub, privateKey: `"${priv}"` });
    expect(r.ok && r.privateKey === priv && r.subject === SUBJECT).toBe(true);
  });

  test("the public key pasted as the private key is reported by its decoded length", () => {
    const { pub } = pair();
    expect(checkVapidKeys(pub, pub)).toEqual({ reason: "PRIVATE_KEY_SAME_AS_PUBLIC_KEY", publicBytes: 65, privateBytes: 65 });
    const other = pair().pub;
    expect(checkVapidKeys(pub, other)).toEqual({ reason: "PRIVATE_KEY_LENGTH", publicBytes: 65, privateBytes: 65 });
  });

  test("wrong-length private keys are rejected with the decoded length", () => {
    const { pub } = pair();
    for (const n of [16, 31, 33, 64]) {
      expect(checkVapidKeys(pub, randomBytes(n).toString("base64url"))).toEqual({ reason: "PRIVATE_KEY_LENGTH", publicBytes: 65, privateBytes: n });
    }
  });

  test("a private key from a different pair is a mismatch", () => {
    const a = pair();
    const b = pair();
    expect(checkVapidKeys(a.pub, b.priv)?.reason).toBe("KEY_PAIR_MISMATCH");
  });

  test("PEM, non-base64url, missing and bad public keys are classified", () => {
    const { pub, priv } = pair();
    expect(checkVapidKeys(pub, "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")?.reason).toBe("PRIVATE_KEY_PEM_FORMAT");
    expect(checkVapidKeys(pub, "not base64url!!")?.reason).toBe("PRIVATE_KEY_NOT_BASE64URL");
    expect(checkVapidKeys(pub, "")?.reason).toBe("NOT_CONFIGURED");
    expect(checkVapidKeys(undefined, priv)?.reason).toBe("NOT_CONFIGURED");
    expect(checkVapidKeys(randomBytes(33).toString("base64url"), priv)?.reason).toBe("PUBLIC_KEY_LENGTH");
    expect(resolveVapidConfig({ subject: "", publicKey: pub, privateKey: priv }).ok).toBe(false);
  });

  test("diagnostics and log lines never contain key material", () => {
    const { pub, priv } = pair();
    for (const bad of [pub, randomBytes(20).toString("base64url"), pair().priv]) {
      const r = resolveVapidConfig({ subject: SUBJECT, publicKey: pub, privateKey: bad });
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const text = JSON.stringify(r.diagnostics) + describeVapidProblem("test-fn", r.diagnostics);
        expect(text).not.toContain(bad);
        expect(text).not.toContain(pub);
        expect(text).not.toContain(priv);
      }
    }
  });
});
