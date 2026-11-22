/** The frame table that comes with a public recording: one row per frame,
 * with the kind of frame and the text read off the screen of the angiography
 * system (the layout of the TAIR recordings). The C-arm angles and the field
 * size are taken where the text reads as exactly that; a frame whose text
 * does not is given the last reading before it. */

export const SIDECAR_LAYOUT = "screen_text_csv_v1";
export const SIDECAR_LIMITS = {
  max_chars: 64 * 1024 * 1024,
  max_frames: 1_000_000,
  max_kinds: 255,
} as const;
const COLUMNS = {
  frame: "frame",
  kind: "frame_type",
  field: "BottomLeft_1",
  angles: "BottomLeft_3",
} as const;

export type RecordingSidecar = {
  frames: number;
  /** The kinds of frame named in the table, and each frame's. */
  kinds: string[];
  kind: Uint8Array;
  /** Positive toward the patient's left (LAO) and toward the head
   * (cranial), as the planner's views. NaN where no angles were ever read. */
  primary_deg: Float32Array;
  secondary_deg: Float32Array;
  /** The field size shown, in centimeters. NaN where none was ever read. */
  field_cm: Float32Array;
  /** Frames whose own text was read. */
  read: { angles: number; field: number };
};

const PRIMARY = /^(?:([RL])A[O0] ?)?(\d{1,3})[°*]$/,
  SECONDARY = /^(?:(C[RP]AN|CAUD) ?)?(\d{1,2})[°*]$/,
  FIELD = /^cm ?([1-9]\d)$/;

/** Primary and secondary angle in degrees, or null. The text is a side and
 * an angle twice, as "LAO 9°/CRAN 12°"; an angle of zero has no side. Read
 * with a zero for the O, a P for the R and a star for the degree mark, which
 * the screen reading often gives. */
export function parseAngles(text: string): [number, number] | null {
  const parts = text.split("/");
  if (parts.length !== 2) return null;
  const first = PRIMARY.exec(parts[0].trim()),
    second = SECONDARY.exec(parts[1].trim());
  if (!first || !second) return null;
  const primary = Number(first[2]),
    secondary = Number(second[2]);
  if (
    (first[1] === undefined) !== (primary === 0) ||
    (second[1] === undefined) !== (secondary === 0) ||
    primary > 180 ||
    secondary > 90
  )
    return null;
  return [
    first[1] === "R" ? -primary : primary,
    second[1] === "CAUD" ? -secondary : secondary,
  ];
}

/** The field size in centimeters from a text as "cm 32", or null. */
export function parseField(text: string): number | null {
  const found = FIELD.exec(text);
  return found ? Number(found[1]) : null;
}

/** Rows of comma-separated text; a field may stand in double quotes. */
function rows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [],
    field = "",
    quoted = false,
    i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const end = () => {
    row.push(field);
    field = "";
  };
  for (; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') {
        field += '"';
        i++;
      } else quoted = false;
    } else if (c === '"' && field === "") quoted = true;
    else if (c === ",") end();
    else if (c === "\n" || c === "\r") {
      // The second character of a line ending ends an empty row, left out.
      end();
      if (row.length > 1 || row[0] !== "") out.push(row);
      row = [];
    } else field += c;
  }
  if (quoted) throw new Error("The frame table has an open quote");
  end();
  if (row.length > 1 || row[0] !== "") out.push(row);
  return out;
}

/** Fills each frame without a reading from the one before it, and the frames
 * before the first reading from that reading. */
function carried(values: Float32Array) {
  let first = NaN;
  for (let k = 0; k < values.length; k++)
    if (Number.isNaN(values[k])) values[k] = k ? values[k - 1] : NaN;
    else if (Number.isNaN(first)) first = values[k];
  for (let k = 0; k < values.length && Number.isNaN(values[k]); k++)
    values[k] = first;
}

export function parseSidecar(text: string): RecordingSidecar {
  if (text.length > SIDECAR_LIMITS.max_chars)
    throw new Error("The frame table is too large");
  const [head, ...body] = rows(text);
  if (!head || !body.length) throw new Error("The frame table is empty");
  if (body.length > SIDECAR_LIMITS.max_frames)
    throw new Error("The frame table is too large");
  const at = Object.fromEntries(
    Object.entries(COLUMNS).map(([name, column]) => {
      const k = head.indexOf(column);
      if (k < 0) throw new Error(`The frame table has no column ${column}`);
      return [name, k];
    }),
  ) as Record<keyof typeof COLUMNS, number>;
  const needed = Math.max(...Object.values(at)) + 1,
    frames = body.length,
    kinds: string[] = [],
    kind = new Uint8Array(frames),
    primary = new Float32Array(frames).fill(NaN),
    secondary = new Float32Array(frames).fill(NaN),
    field = new Float32Array(frames).fill(NaN),
    read = { angles: 0, field: 0 };
  body.forEach((row, k) => {
    if (row.length < needed)
      throw new Error(`Row ${k + 1} of the frame table is cut short`);
    if (row[at.frame] !== String(k))
      throw new Error(`Row ${k + 1} of the frame table is not frame ${k}`);
    let named = kinds.indexOf(row[at.kind]);
    if (named < 0) {
      if (kinds.length >= SIDECAR_LIMITS.max_kinds)
        throw new Error("The frame table has too many kinds of frame");
      named = kinds.push(row[at.kind]) - 1;
    }
    kind[k] = named;
    const angles = parseAngles(row[at.angles]),
      size = parseField(row[at.field]);
    if (angles) {
      [primary[k], secondary[k]] = angles;
      read.angles++;
    }
    if (size !== null) {
      field[k] = size;
      read.field++;
    }
  });
  carried(primary);
  carried(secondary);
  carried(field);
  return {
    frames,
    kinds,
    kind,
    primary_deg: primary,
    secondary_deg: secondary,
    field_cm: field,
    read,
  };
}
