import { describe, expect, it } from "vitest";
import {
  parseAngles,
  parseField,
  parseSidecar,
  SIDECAR_LIMITS,
} from "./recordingSidecar";

const HEAD =
  "frame,frame_type,relative_time,time_known,time_origin_uncertain,BottomLeft_1,BottomLeft_2,BottomLeft_3,BottomRight_1";
const table = (rows: [string, string, string][]) =>
  [
    HEAD,
    ...rows.map(
      ([kind, field, angles], k) =>
        `${k},${kind},0:10:20,1,0,${field},B,${angles},EE13%`,
    ),
  ].join("\n") + "\n";

describe("C-arm angles read off the screen text", () => {
  it("reads the two angles with their sides", () => {
    expect(parseAngles("LAO 9°/CRAN 12°")).toEqual([9, 12]);
    expect(parseAngles("RAO 90°/0°")).toEqual([-90, 0]);
    expect(parseAngles("LAO 10°/ CAUD 13°")).toEqual([10, -13]);
    expect(parseAngles("0°/0°")).toEqual([0, 0]);
    expect(parseAngles("0°/CRAN 25°")).toEqual([0, 25]);
    expect(parseAngles("RAO 113°/CAUD 4°")).toEqual([-113, -4]);
  });

  it("reads the usual misreadings of the text: 0 for O, P for R, a star for the degree mark, a missing space", () => {
    expect(parseAngles("RA0 90°/CPAN1°")).toEqual([-90, 1]);
    expect(parseAngles("RA050°/CPAN1°")).toEqual([-50, 1]);
    expect(parseAngles("LA010°/0°")).toEqual([10, 0]);
    expect(parseAngles("LAO 9°/CRAN 12*")).toEqual([9, 12]);
    expect(parseAngles("RAO 88*/CPAN2°")).toEqual([-88, 2]);
  });

  it("does not read a text that is cut short, has more after it, or cannot be an angle", () => {
    for (const text of [
      "",
      "0/0",
      "0/0°",
      "0°/0",
      "0°/0°A",
      "RAO 90°/0°0",
      "RAO90°/CPAN11",
      "RAO 90°10°1",
      "RA07/0°",
      "LAO 36°/0",
      "RAO 113°/0PAN16*",
      "RAO 107°/0AUD 4",
      // A side without an angle, and an angle without a side.
      "LAO 0°/0°",
      "9°/0°",
      "0°/CRAN 0°",
      "0°/12°",
      // Beyond what a C-arm turns.
      "LAO 181°/0°",
      "0°/CRAN 91°",
      "LAO 9°/CRAN 12°/0°",
    ])
      expect(parseAngles(text), text).toBeNull();
    expect(parseAngles("LAO 180°/CRAN 90°")).toEqual([180, 90]);
  });
});

describe("the field size read off the screen text", () => {
  it("reads two digits after cm, and nothing else", () => {
    expect(parseField("cm32")).toBe(32);
    expect(parseField("cm 42")).toBe(42);
    for (const text of ["", "cm321", "cm 32N", "cm|8", "32", "cm3", "cm00"])
      expect(parseField(text), text).toBeNull();
  });
});

describe("the frame table of a recording", () => {
  it("gives every frame its kind, and the angles and field last read", () => {
    const found = parseSidecar(
      table([
        ["Roadmap", "cm32", "RAO 90°/0°"],
        ["Roadmap", "cm321", "RAO 90°/0°0"],
        ["WC50", "cm 42", "RAO91°/CPAN 2°"],
        ["WC50", "", ""],
        ["Unlabeled", "cm42", "0/0"],
      ]),
    );
    expect(found.frames).toBe(5);
    expect(Array.from(found.kind, (k) => found.kinds[k])).toEqual([
      "Roadmap",
      "Roadmap",
      "WC50",
      "WC50",
      "Unlabeled",
    ]);
    expect(Array.from(found.primary_deg)).toEqual([-90, -90, -91, -91, -91]);
    expect(Array.from(found.secondary_deg)).toEqual([0, 0, 2, 2, 2]);
    expect(Array.from(found.field_cm)).toEqual([32, 32, 42, 42, 42]);
    expect(found.read).toEqual({ angles: 2, field: 3 });
  });

  it("gives the frames before the first reading that reading", () => {
    const found = parseSidecar(
      table([
        ["WC23", "", "0/0"],
        ["WC23", "cm 48", ""],
        ["WC23", "", "LAO 4°/CRAN 16°"],
      ]),
    );
    expect(Array.from(found.primary_deg)).toEqual([4, 4, 4]);
    expect(Array.from(found.secondary_deg)).toEqual([16, 16, 16]);
    expect(Array.from(found.field_cm)).toEqual([48, 48, 48]);
  });

  it("has no angles or field where none was ever read", () => {
    const found = parseSidecar(table([["WC23", "cm", "0/0"]]));
    expect(found.primary_deg[0]).toBeNaN();
    expect(found.secondary_deg[0]).toBeNaN();
    expect(found.field_cm[0]).toBeNaN();
    expect(found.read).toEqual({ angles: 0, field: 0 });
  });

  it("reads quoted fields, a byte order mark, and either line ending", () => {
    const found = parseSidecar(
      "\ufeff" +
        HEAD +
        '\r\n0,"WC, 50",0:10:20,1,0,cm32,B,"LAO 9°/CRAN 12°","say ""a"""\r\n',
    );
    expect(found.kinds).toEqual(["WC, 50"]);
    expect(found.primary_deg[0]).toBe(9);
  });

  it("refuses a table that is not one row per frame in this layout", () => {
    const row = "0,WC50,0:10:20,1,0,cm32,B,0°/0°,EE13%";
    for (const [text, why] of [
      ["", "The frame table is empty"],
      [HEAD + "\n", "The frame table is empty"],
      [
        HEAD.replace("BottomLeft_3", "Angles") + "\n" + row,
        "The frame table has no column BottomLeft_3",
      ],
      [
        HEAD.replace("frame_type", "kind") + "\n" + row,
        "The frame table has no column frame_type",
      ],
      [
        HEAD + "\n" + row.replace(/^0/, "1"),
        "Row 1 of the frame table is not frame 0",
      ],
      [
        HEAD + "\n" + row + "\n" + row,
        "Row 2 of the frame table is not frame 1",
      ],
      [HEAD + "\n0,WC50,0:10:20", "Row 1 of the frame table is cut short"],
      [
        HEAD + '\n0,"WC50,0:10:20,1,0,cm32,B,0°/0°,EE13%',
        "The frame table has an open quote",
      ],
    ] as const)
      expect(() => parseSidecar(text), why).toThrow(why);
    expect(() =>
      parseSidecar(HEAD + "\n" + "x".repeat(SIDECAR_LIMITS.max_chars)),
    ).toThrow("The frame table is too large");
  });

  it("refuses more kinds of frame than it can name", () => {
    const rows = Array.from(
      { length: SIDECAR_LIMITS.max_kinds + 1 },
      (_, k): [string, string, string] => [`K${k}`, "cm32", "0°/0°"],
    );
    expect(() => parseSidecar(table(rows))).toThrow(
      "The frame table has too many kinds of frame",
    );
    expect(parseSidecar(table(rows.slice(1))).kinds).toHaveLength(
      SIDECAR_LIMITS.max_kinds,
    );
  });
});
