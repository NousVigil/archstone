import { describe, it, expect } from "vitest";
import { mapColumnType, isRequiredColumn, COLUMN_TYPE_NOT_EXPRESSIBLE } from "../src/adapters/postgres/columns";
import { canRecordSqlContract } from "../src/adapters/postgres/contract";

// ADR-0012 D-10 — `archstone init`'s Postgres adapter, the pure/mechanical pieces.

describe("mapColumnType (S-US9.3, D-10)", () => {
  it("skips json, jsonb, and array columns with column-type-not-expressible", () => {
    for (const pgType of ["json", "jsonb", "ARRAY"]) {
      const m = mapColumnType(pgType, "flag_col");
      expect(m.ok).toBe(false);
      if (!m.ok) expect(m.reasonCode).toBe(COLUMN_TYPE_NOT_EXPRESSIBLE);
    }
  });

  it("maps timestamp/timestamptz to datetime, date to date, uuid to identifier", () => {
    expect(mapColumnType("timestamp without time zone", "created_at")).toEqual({ ok: true, type: "datetime" });
    expect(mapColumnType("timestamptz", "created_at")).toEqual({ ok: true, type: "datetime" });
    expect(mapColumnType("date", "week_ending")).toEqual({ ok: true, type: "date" });
    expect(mapColumnType("uuid", "id")).toEqual({ ok: true, type: "identifier" });
  });

  it("maps only the types the driver returns as a JS number to quantity; bigint and numeric stay strings", () => {
    for (const t of ["integer", "smallint", "real", "double precision"]) expect(mapColumnType(t, "n")).toEqual({ ok: true, type: "quantity" });
    for (const t of ["bigint", "numeric", "decimal"]) expect(mapColumnType(t, "n")).toEqual({ ok: true, type: "string" });
  });

  it("skips types whose driver value is not the declared scalar (interval, bytea, geometric, oid)", () => {
    for (const t of ["interval", "bytea", "point", "polygon", "oid"]) {
      const m = mapColumnType(t, "c");
      expect(m.ok, t).toBe(false);
    }
  });

  it("falls back to string for text-like types", () => {
    expect(mapColumnType("character varying", "headline")).toEqual({ ok: true, type: "string" });
    expect(mapColumnType("text", "headline")).toEqual({ ok: true, type: "string" });
  });
});

describe("isRequiredColumn (BR-19)", () => {
  it("is_nullable = 'NO' means required; anything else means optional", () => {
    expect(isRequiredColumn("NO")).toBe(true);
    expect(isRequiredColumn("YES")).toBe(false);
  });
});

describe("canRecordSqlContract (BR-20)", () => {
  it("refuses to record a contract with no negative identity available", () => {
    expect(canRecordSqlContract(undefined)).toBe(false);
    expect(canRecordSqlContract({ principal: "" })).toBe(false);
  });

  it("allows recording once a negative identity is available", () => {
    expect(canRecordSqlContract({ principal: "tenant-b-session" })).toBe(true);
  });
});
