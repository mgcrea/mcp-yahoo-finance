import { describe, expect, it } from "vitest";

import { nanToNull, sanitize, toISO, unwrap } from "#/lib/format";

describe("toISO", () => {
  it("treats small numbers as unix seconds", () => {
    expect(toISO(1_700_000_000)).toBe("2023-11-14T22:13:20.000Z");
  });

  it("treats large numbers as unix milliseconds", () => {
    expect(toISO(1_700_000_000_000)).toBe("2023-11-14T22:13:20.000Z");
  });

  it("passes through Date objects", () => {
    expect(toISO(new Date("2024-01-02T03:04:05Z"))).toBe("2024-01-02T03:04:05.000Z");
  });

  it("returns null for unparseable input", () => {
    expect(toISO(undefined)).toBeNull();
    expect(toISO(null)).toBeNull();
  });
});

describe("unwrap / nanToNull", () => {
  it("unwraps {raw} wrappers", () => {
    expect(unwrap({ raw: 42, fmt: "42.00" })).toBe(42);
  });

  it("leaves plain values alone", () => {
    expect(unwrap(7)).toBe(7);
    expect(unwrap("x")).toBe("x");
  });

  it("maps NaN to null", () => {
    expect(nanToNull(NaN)).toBeNull();
    expect(nanToNull(3)).toBe(3);
  });
});

describe("sanitize", () => {
  it("deep-unwraps wrappers, converts Dates, and maps NaN to null", () => {
    const input = {
      price: { raw: 12.5, fmt: "12.50" },
      when: new Date("2024-01-01T00:00:00Z"),
      bad: NaN,
      nested: [{ v: { raw: 1, longFmt: "1" } }],
    };
    expect(sanitize(input)).toEqual({
      price: 12.5,
      when: "2024-01-01T00:00:00.000Z",
      bad: null,
      nested: [{ v: 1 }],
    });
  });
});
