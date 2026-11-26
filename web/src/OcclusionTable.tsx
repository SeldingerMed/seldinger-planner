export type OcclusionEstimate = {
  treatment: string;
  technique: string;
  complete_occlusion: number;
  ci95?: [number, number];
  between_centre_range95: [number, number];
  published_studies: number;
  published_aneurysms: number;
};

export type OcclusionEstimates = {
  months_after_treatment: number;
  set_to_published_average: string[];
  estimates: OcclusionEstimate[];
  model: { basis: string; not_modelled: string };
};

const pct = (value: number) => `${Math.round(value * 100)}%`;

export default function OcclusionTable({
  estimates,
}: {
  estimates: OcclusionEstimates;
}) {
  const months = estimates.months_after_treatment;
  return (
    <div className="occlusion-estimates">
      <h4>
        Complete occlusion{" "}
        {months === 0 ? "at end of procedure" : `at ${months} months`}
      </h4>
      <table>
        <thead>
          <tr>
            <th scope="col">Treatment</th>
            <th scope="col">Expected</th>
            <th scope="col">95% CI</th>
            <th scope="col">Between centres</th>
            <th scope="col">Studies</th>
          </tr>
        </thead>
        <tbody>
          {estimates.estimates.map((row) => (
            <tr key={row.technique}>
              <th scope="row">{row.technique}</th>
              <td>{pct(row.complete_occlusion)}</td>
              <td>
                {row.ci95 ? `${pct(row.ci95[0])}–${pct(row.ci95[1])}` : "–"}
              </td>
              <td>
                {pct(row.between_centre_range95[0])}–
                {pct(row.between_centre_range95[1])}
              </td>
              <td>{row.published_studies}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <small>
        {estimates.model.basis}.
        {estimates.set_to_published_average.length > 0 &&
          ` Published average used for: ${estimates.set_to_published_average.join(", ")}.`}{" "}
        Not included: {estimates.model.not_modelled.toLowerCase()}.
      </small>
    </div>
  );
}
