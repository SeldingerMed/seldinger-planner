/** Controlled path profile editor for centerline-path cross-section tracing.
 * Path points are appended from the cursor (max 128) and any path change
 * clears the profiles with an explicit message. Each profile's lumen plane
 * starts EMPTY (origin = path point, normal = path tangent); contours come
 * only from explicit picks via TerritorySectionEditor. Thrombus and
 * calcification start unknown (null); an explicit "no ... observed" sets [].
 * No implicit segmentation or aneurysm-mask requirement is implied.
 */
import { useState } from "react";
import type { NVImage } from "@niivue/niivue";
import TerritorySectionEditor, { type Section } from "./TerritorySectionEditor";
import type { Vec3 } from "./obliqueSlice";

export type Profile = {
  station: number;
  section: Section;
  outer_wall: Section | null;
  thrombus: Section[] | null;
  calcification: Section[] | null;
};

export type PathProfiles = {
  path: Vec3[];
  profiles: Profile[];
};

type LayerClass = "thrombus" | "calcification";

const MAX_PATH = 128;
const MAX_PROFILES = 32;
const MAX_REGIONS = 8;

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

function tangentAt(path: Vec3[], i: number): Vec3 | null {
  if (i < 0 || i >= path.length) return null;
  if (path.length < 2) return null;
  if (i === 0) return sub(path[1], path[0]);
  if (i === path.length - 1)
    return sub(path[path.length - 1], path[path.length - 2]);
  return sub(path[i + 1], path[i - 1]);
}

const emptySection = (origin: Vec3, normal: Vec3): Section => ({
  origin,
  normal,
  contour: [],
});

export default function TerritoryPathEditor({
  value,
  onChange,
  volume,
  cursor,
  disabled = false,
  label,
}: {
  value: PathProfiles;
  onChange: (value: PathProfiles) => void;
  volume: NVImage | null;
  cursor: Vec3 | null;
  disabled?: boolean;
  label?: string;
}) {
  const [stationDraft, setStationDraft] = useState("0");
  const [selectedStation, setSelectedStation] = useState<number | null>(null);
  const [selectedLayer, setSelectedLayer] = useState<
    "lumen" | "outer_wall" | `${LayerClass}-${number}`
  >("lumen");
  const [notice, setNotice] = useState<string | null>(null);

  const selectedProfileIndex =
    selectedStation === null
      ? -1
      : value.profiles.findIndex((p) => p.station === selectedStation);
  const selectedProfile =
    selectedProfileIndex >= 0 ? value.profiles[selectedProfileIndex] : null;

  const appendCursorPoint = () => {
    if (disabled || !cursor || value.path.length >= MAX_PATH) return;
    const last = value.path.at(-1);
    if (last && last.every((v, i) => v === cursor[i])) {
      setNotice(
        "Cursor point duplicates the last path point; move the cursor first",
      );
      return;
    }
    const changed = value.profiles.length > 0;
    onChange({
      path: [...value.path, cursor],
      profiles: changed ? [] : value.profiles,
    });
    setNotice(changed ? "Path changed; profiles cleared" : null);
    setSelectedStation(null);
  };

  const undoPathPoint = () => {
    if (disabled || value.path.length === 0) return;
    const changed = value.profiles.length > 0;
    onChange({
      path: value.path.slice(0, -1),
      profiles: changed ? [] : value.profiles,
    });
    setNotice(changed ? "Path changed; profiles cleared" : null);
    setSelectedStation(null);
  };

  const addProfile = () => {
    if (disabled) return;
    const station = Number(stationDraft);
    if (
      stationDraft.trim() === "" ||
      !Number.isInteger(station) ||
      station < 0 ||
      station >= value.path.length
    ) {
      setNotice(
        value.path.length
          ? `Choose an integer path index from 0 to ${value.path.length - 1}`
          : "Append path points before choosing a profile station",
      );
      return;
    }
    if (value.profiles.some((p) => p.station === station)) {
      setNotice("A profile already exists at this station; select it to edit.");
      return;
    }
    if (value.profiles.length >= MAX_PROFILES) {
      setNotice(
        "Profile limit 32 reached; remove a profile before adding another.",
      );
      return;
    }
    const tangent = tangentAt(value.path, station);
    if (
      !tangent ||
      !tangent.every(Number.isFinite) ||
      Math.hypot(...tangent) <= 1e-12
    ) {
      setNotice("The selected station needs a nonzero path tangent.");
      return;
    }
    const next = [
      ...value.profiles,
      {
        station,
        section: emptySection(value.path[station], tangent),
        outer_wall: null,
        thrombus: null,
        calcification: null,
      },
    ].sort((a, b) => a.station - b.station);
    onChange({ ...value, profiles: next });
    setNotice(null);
    setSelectedStation(station);
    setSelectedLayer("lumen");
  };

  const updateSelected = (update: (p: Profile) => Profile) => {
    if (disabled || selectedProfileIndex < 0) return;
    setNotice(null);
    const next = value.profiles.map((p, i) =>
      i === selectedProfileIndex ? update(p) : p,
    );
    onChange({ ...value, profiles: next });
  };

  const removeProfile = (station: number) => {
    if (disabled) return;
    onChange({
      ...value,
      profiles: value.profiles.filter((p) => p.station !== station),
    });
    if (selectedStation === station) setSelectedStation(null);
  };

  const addRegion = (cls: LayerClass) => {
    if (!selectedProfile) return;
    const current = selectedProfile[cls];
    if (current && current.length >= MAX_REGIONS) return;
    const region = emptySection(
      selectedProfile.section.origin,
      selectedProfile.section.normal,
    );
    updateSelected((p) => ({
      ...p,
      [cls]: current ? [...current, region] : [region],
    }));
    setSelectedLayer(`${cls}-${current ? current.length : 0}`);
  };

  const setLayerSection = (section: Section) => {
    if (!selectedProfile) return;
    if (selectedLayer === "lumen") {
      updateSelected((p) => ({ ...p, section }));
    } else if (selectedLayer === "outer_wall") {
      updateSelected((p) => ({ ...p, outer_wall: section }));
    } else {
      const [cls, indexText] = selectedLayer.split("-");
      const index = Number(indexText);
      updateSelected((p) => {
        const list = p[cls as LayerClass];
        if (
          !list ||
          !Number.isInteger(index) ||
          index < 0 ||
          index >= list.length
        )
          return p;
        return {
          ...p,
          [cls]: list.map((s, i) => (i === index ? section : s)),
        };
      });
    }
  };

  const tracedSection: Section | null = (() => {
    if (!selectedProfile) return null;
    if (selectedLayer === "lumen") return selectedProfile.section;
    if (selectedLayer === "outer_wall") return selectedProfile.outer_wall;
    const [cls, indexText] = selectedLayer.split("-");
    const list = selectedProfile[cls as LayerClass];
    const index = Number(indexText);
    return list && index >= 0 && index < list.length ? list[index] : null;
  })();

  const tracedLabel = (() => {
    if (!selectedProfile) return "";
    if (selectedLayer === "lumen") return `lumen`;
    if (selectedLayer === "outer_wall") return `outer wall`;
    const [cls, i] = selectedLayer.split("-");
    return `${cls} region ${Number(i) + 1}`;
  })();

  return (
    <section
      className="territory-path-editor"
      aria-label={label ?? "Path profile editor"}
    >
      <div className="territory-path-plane">
        <span>Path points: {value.path.length}</span>
        <button
          type="button"
          disabled={disabled || !cursor || value.path.length >= MAX_PATH}
          onClick={appendCursorPoint}
        >
          Append cursor point
        </button>
        <button
          type="button"
          disabled={disabled || value.path.length === 0}
          onClick={undoPathPoint}
        >
          Undo path point
        </button>
        <label>
          Profile station
          <input
            aria-label="Profile station"
            value={stationDraft}
            disabled={disabled}
            onChange={(e) => setStationDraft(e.target.value)}
          />
        </label>
        <button type="button" disabled={disabled} onClick={addProfile}>
          Add profile at station
        </button>
        <span>
          Profiles: {value.profiles.length} / {MAX_PROFILES}
        </span>
        {notice && <p role="status">{notice}</p>}
      </div>
      <ul className="territory-path-profiles">
        {value.profiles.map((p) => (
          <li key={p.station}>
            <button
              type="button"
              disabled={disabled}
              onClick={() => {
                setSelectedStation(p.station);
                setSelectedLayer("lumen");
                setNotice(null);
              }}
            >
              Profile at station {p.station}
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => removeProfile(p.station)}
            >
              Remove profile at station {p.station}
            </button>
          </li>
        ))}
      </ul>
      {selectedProfile && (
        <div className="territory-path-tracing">
          <div className="territory-path-layers">
            <button
              type="button"
              disabled={disabled}
              onClick={() => setSelectedLayer("lumen")}
            >
              Lumen
            </button>
            <button
              type="button"
              disabled={disabled}
              onClick={() => setSelectedLayer("outer_wall")}
            >
              Outer wall
            </button>
            <button
              type="button"
              disabled={disabled || selectedProfile.outer_wall !== null}
              onClick={() => {
                if (selectedProfile.outer_wall) return;
                updateSelected((p) => ({
                  ...p,
                  outer_wall: emptySection(p.section.origin, p.section.normal),
                }));
                setSelectedLayer("outer_wall");
              }}
            >
              Add outer wall region
            </button>
            <button
              type="button"
              disabled={disabled || selectedProfile.outer_wall === null}
              onClick={() =>
                updateSelected((p) => ({ ...p, outer_wall: null }))
              }
            >
              Clear outer wall
            </button>
            {(["thrombus", "calcification"] as LayerClass[]).map((cls) => (
              <span key={cls}>
                {selectedProfile[cls]?.map((_, i) => (
                  <span key={i}>
                    <button
                      key={i}
                      type="button"
                      disabled={disabled}
                      onClick={() => setSelectedLayer(`${cls}-${i}`)}
                    >
                      {cls === "thrombus" ? "Thrombus" : "Calcification"} region{" "}
                      {i + 1}
                    </button>
                    <button
                      disabled={disabled}
                      onClick={() => {
                        updateSelected((p) => {
                          const regions =
                            p[cls]?.filter((_, index) => index !== i) ?? [];
                          return {
                            ...p,
                            [cls]: regions.length ? regions : null,
                          };
                        });
                        if (selectedProfile[cls]?.length === 1)
                          setNotice(
                            `Last ${cls} region annotation removed; class is unknown. Select No ${cls} observed to declare zero.`,
                          );
                        //Deleting an annotation is not an assessment of absence.
                        //The explicit No-observed action is the sole zero declaration.
                        setSelectedLayer("lumen");
                      }}
                    >
                      Remove {cls} region {i + 1}
                    </button>
                  </span>
                ))}
                <button
                  type="button"
                  disabled={
                    disabled ||
                    (selectedProfile[cls] !== null &&
                      selectedProfile[cls]!.length >= MAX_REGIONS)
                  }
                  onClick={() => addRegion(cls)}
                >
                  Add {cls} region
                </button>
                <button
                  type="button"
                  disabled={disabled || selectedProfile[cls]?.length === 0}
                  onClick={() => updateSelected((p) => ({ ...p, [cls]: [] }))}
                >
                  No {cls} observed
                </button>
                <button
                  disabled={disabled || selectedProfile[cls] === null}
                  onClick={() => {
                    updateSelected((p) => ({ ...p, [cls]: null }));
                    setSelectedLayer("lumen");
                  }}
                >
                  Mark {cls} unknown
                </button>
              </span>
            ))}
          </div>
          {tracedSection && (
            <TerritorySectionEditor
              key={`${selectedStation}:${selectedLayer}`}
              label={`Section editor: ${tracedLabel}`}
              value={tracedSection}
              onChange={setLayerSection}
              volume={volume}
              cursor={cursor}
              disabled={disabled}
            />
          )}
        </div>
      )}
    </section>
  );
}
