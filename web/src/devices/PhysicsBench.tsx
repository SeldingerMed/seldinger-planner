import { useState } from "react";
import {
  braidForeshortening,
  coilPacking,
  screenPressureDrop,
} from "./physics";
export default function PhysicsBench({
  category,
  diameter,
  length,
  coilLength,
}: {
  category: string;
  diameter: number;
  length: number;
  coilLength: number;
}) {
  const [enabled, setEnabled] = useState(false),
    [porosity, setPorosity] = useState(0.75),
    [pore, setPore] = useState(0.12),
    [velocity, setVelocity] = useState(0.05),
    [expanded, setExpanded] = useState(1),
    [primary, setPrimary] = useState(""),
    [volume, setVolume] = useState("");
  const screen = enabled
    ? screenPressureDrop({
        porosity,
        hydraulicDiameterMm: pore,
        velocityMps: velocity,
        densityKgM3: 1060,
        viscosityPas: 0.0035,
      })
    : null;
  let braid: null | ReturnType<typeof braidForeshortening> = null;
  try {
    braid = braidForeshortening({
      nominalDiameterMm: diameter,
      nominalLengthMm: length,
      turns: 2,
      expandedDiameterMm: diameter * expanded,
    });
  } catch {
    /* Geometry outside the ideal-helix range has no predicted length. */
  }
  let pack: null | ReturnType<typeof coilPacking> = null;
  try {
    if (primary && volume) pack = coilPacking(+primary, coilLength, +volume);
  } catch {
    /* Invalid or absent physical inputs produce no number. */
  }
  return (
    <details className="ds-physics">
      <summary>Research physics bench</summary>
      {category === "flow-diverter" && (
        <>
          <p>
            Ideal inextensible braid, two turns per strand. This tests
            diameter/length coupling, not a calibrated deployment model for this
            product.
          </p>
          <label>
            Expansion ratio <output>{expanded.toFixed(2)} × nominal</output>
            <input
              aria-label="Ideal braid expansion ratio"
              type="range"
              min={0.7}
              max={1.15}
              step={0.01}
              value={expanded}
              onChange={(e) => setExpanded(+e.target.value)}
            />
          </label>
          <p>
            {braid
              ? `Ideal axial length ${braid.deployedLengthMm.toFixed(2)} mm; strand length ${braid.wireLengthMm.toFixed(2)} mm conserved.`
              : "Outside the inextensible helix range."}
          </p>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Explore hypothetical screen parameters
          </label>
          {enabled && (
            <>
              <label>
                Open-area porosity <output>{porosity.toFixed(2)}</output>
                <input
                  aria-label="Hypothetical screen porosity"
                  type="range"
                  min={0.1}
                  max={0.95}
                  step={0.01}
                  value={porosity}
                  onChange={(e) => setPorosity(+e.target.value)}
                />
              </label>
              <label>
                Hydraulic pore diameter (mm) <output>{pore.toFixed(2)}</output>
                <input
                  aria-label="Hypothetical hydraulic pore diameter"
                  type="range"
                  min={0.02}
                  max={0.5}
                  step={0.01}
                  value={pore}
                  onChange={(e) => setPore(+e.target.value)}
                />
              </label>
              <label>
                Normal screen velocity (m/s){" "}
                <output>{velocity.toFixed(2)}</output>
                <input
                  aria-label="Hypothetical normal screen velocity"
                  type="range"
                  min={0}
                  max={0.3}
                  step={0.01}
                  value={velocity}
                  onChange={(e) => setVelocity(+e.target.value)}
                />
              </label>
              <strong>
                Local screen pressure drop: {screen!.totalPa.toFixed(2)} Pa
              </strong>
              <svg
                viewBox="0 0 240 95"
                role="img"
                aria-label="Computed thin-screen pressure versus normal velocity curve"
              >
                <path d="M15 5 V78 H235" stroke="#6e8299" fill="none" />
                <polyline
                  points={Array.from({ length: 31 }, (_, i) => {
                    const result = screenPressureDrop({
                      porosity,
                      hydraulicDiameterMm: pore,
                      velocityMps: i / 100,
                      densityKgM3: 1060,
                      viscosityPas: 0.0035,
                    });
                    const maximum = screenPressureDrop({
                      porosity,
                      hydraulicDiameterMm: pore,
                      velocityMps: 0.3,
                      densityKgM3: 1060,
                      viscosityPas: 0.0035,
                    }).totalPa;
                    return `${15 + i * 7},${78 - (result.totalPa / maximum) * 68}`;
                  }).join(" ")}
                  stroke="#85d7bd"
                  fill="none"
                />
                <text x="20" y="93" fill="#a7b7ca" fontSize="8">
                  0 → 0.30 m/s · independent normalized pressure axis
                </text>
              </svg>
              <p>
                Not a patient-specific CFD solution. Porosity and pore size here
                are hypothetical, not measured or inferred for the selected
                device. Assumed density1060 kg/m³ and viscosity0.0035 Pa·s. No
                sac-flow reduction or occlusion probability follows from this
                curve.
              </p>
              <p>
                <a
                  href="https://pmc.ncbi.nlm.nih.gov/articles/PMC9372908/"
                  target="_blank"
                  rel="noreferrer"
                >
                  Abdehkakha et al.,2021, Eq.1
                </a>
                : thin-screen viscous plus inertial pressure loss. Our
                implementation reproduces the equation, not the paper's
                validation study.
              </p>
            </>
          )}
        </>
      )}
      {category === "intrasaccular" && (
        <p>
          FD thin-screen coefficients are not applied to WEB or other
          intrasaccular devices. Their deployment and flow response need
          separate calibration; the current cage is geometric.
        </p>
      )}
      {category === "coil" && (
        <>
          <p>
            Primary-coil volume arithmetic requires explicit physical inputs.
            The illustrative preview spacing is not a manufacturer's primary
            coil diameter.
          </p>
          <label>
            Operator-supplied primary coil diameter (mm)
            <input
              aria-label="Primary coil diameter (mm)"
              type="number"
              min={0.01}
              max={1}
              step={0.01}
              value={primary}
              onChange={(e) => setPrimary(e.target.value)}
            />
          </label>
          <label>
            Operator-supplied sac volume (mm³)
            <input
              aria-label="Sac volume (mm3)"
              type="number"
              min={0.01}
              value={volume}
              onChange={(e) => setVolume(e.target.value)}
            />
          </label>
          {pack ? (
            <p>
              Calculated primary-coil volume{" "}
              {pack.primaryCoilVolumeMm3.toFixed(2)} mm³; material-volume
              packing {(100 * pack.packingFraction).toFixed(1)}%.{" "}
              {pack.packingFraction > 1
                ? "Input volume exceeds the supplied sac volume."
                : ""}{" "}
              Not flow resistance or probability of occlusion.
            </p>
          ) : (
            <p>
              No packing value: valid positive primary diameter and sac volume
              are required.
            </p>
          )}
        </>
      )}
    </details>
  );
}
