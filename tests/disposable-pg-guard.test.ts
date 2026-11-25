// The guard that keeps real-database tests away from staging and production (tests/helpers/disposable-pg.ts).
import { describe, expect, test } from "bun:test";
import { assertDisposablePgUrl } from "./helpers/disposable-pg";

const YES = { SITE_CODE_PG_ALLOW_WRITES: "yes" };
describe("assertDisposablePgUrl", () => {
  test("accepts a local database with a disposable-looking name", () => {
    expect(assertDisposablePgUrl("postgresql://postgres:pw@localhost:5432/mgl_test", YES).hostname).toBe("localhost");
    expect(assertDisposablePgUrl("postgres://u@127.0.0.1/scratch_db", YES)).toBeTruthy();
    expect(assertDisposablePgUrl("postgresql://u@[::1]:5432/my_disposable", YES)).toBeTruthy();
  });
  test("refuses without the explicit opt-in or without a URL", () => {
    expect(() => assertDisposablePgUrl("postgresql://postgres@localhost/mgl_test", {})).toThrow(/ALLOW_WRITES/);
    expect(() => assertDisposablePgUrl(undefined, YES)).toThrow(/not set/);
  });
  test("refuses remote hosts, Supabase and pooler URLs, and the known production project", () => {
    for (const url of [
      "postgresql://postgres:pw@db.ewukneoblhogtreeekqc.supabase.co:5432/postgres_test",
      "postgresql://postgres.ewukneoblhogtreeekqc:pw@aws-0-eu.pooler.supabase.com:6543/test",
      "postgresql://postgres:pw@10.0.0.5:5432/mgl_test",
      "postgresql://postgres:pw@staging.example.com/mgl_test",
      "postgresql://postgres:pw@localhost:5432/mgl_test?options=ewukneoblhogtreeekqc",
    ]) expect(() => assertDisposablePgUrl(url, YES)).toThrow(/Refusing/);
  });
  test("refuses a local database whose name does not say it is disposable", () => {
    for (const name of ["postgres", "mgl", "mineguard", "production"]) {
      expect(() => assertDisposablePgUrl(`postgresql://postgres@localhost:5432/${name}`, YES)).toThrow(/must contain/);
    }
  });
  test("refuses a non-postgres or malformed URL", () => {
    expect(() => assertDisposablePgUrl("https://localhost/test", YES)).toThrow(/Refusing/);
    expect(() => assertDisposablePgUrl("not a url", YES)).toThrow(/Refusing/);
  });
});
