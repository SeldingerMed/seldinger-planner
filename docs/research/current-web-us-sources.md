# Current US WEB labeling and portfolio: parent-verified sources

Internal source audit and integration inputs, not a device recommendation, stock/availability assertion or completed compatibility engine.

## Official sources independently checked

- Current manufacturer US labeling index: https://www.terumoneuro.com/products/web-family/additional-information/indication-for-use-and-intended-purpose
- Linked US PDF: https://assets.ctfassets.net/ka7vsj9fzri4/1P6kEJiwIQ4eykc5ag2lE6/7faa4c7b4c5ab8e27db6804a72ec83ad/IFU100044_Rev._E_WEB__US_.pdf
- PDF first page: **IFU100044 Rev. E, Revised 2024-02**. Actual946,358-byte source SHA-256 `ce5756b40fa8540ee3f6646a4f8ba300c0e192016e7b23a5c4dde57174077d35` independently computed in parent. US and Canadian documents are separately linked; do not substitute the Canadian or localized CHAPLA version.
- Actual manufacturer US portfolio table viewed in browser: https://www.terumoneuro.com/products/web-family . Marker **MM1357 NA 05/23**, page states **Last Updated Jun18,2026**.
- Extracted exact DOM rows, preserving reference numbers. **37uniqueSKUs** independently counted and normalized, including W5 VIA17 devices. The table is not in the IFU and must retain its separate source/version identity.

Ignored local evidence under `artifacts/device-current-sources/` includes the PDF, `web-us-portfolio-browser.json` and `web-us-portfolio-normalized.json`. No manufacturer marketing images or full documents were added to source control.

## Confirmed delivery table, not complete clinical compatibility

IFU Table1:

| Device family/diameter | Minimum microcatheter ID | Recommended catheter |
| --- | --- | --- |
| W5,4–7mm | 0.017inch | VIA17 |
| W4,4–7mm | 0.021inch | VIA21 |
| W2,8–9mm | 0.027inch | VIA27 |
| W2,10–11mm | 0.033inch | VIA33 |

The live37-SKU table contains W5/W2 references, not W4 references. Do not create a current W4 SKU from the fact that the IFU documents a W4 delivery path. Nominal device size, catheter lumen compatibility, access anatomy, indications, contraindications and actual clinical suitability are separate checks.

## Current sizing language actually retrieved

US IFU procedure steps8–12 specify two orthogonal **2D angiographic fluoroscopic projections**, neck/diameter/height measurements in each projection, a shape-selection consideration using average diameter-to-average neck ratio, and use of average width/smallest height. Step12 still describes approximately1mm larger than average diameter and approximately1mm smaller than smallest height.

Consequences:
- The historical +1/−1 approximation is present in this linked current US document; the earlier helper assertion that it was unconfirmed from all current sources has been superseded by actual PDF review.
- CTA planning measurements are not automatically equivalent to the IFU's fluoroscopic measurements. An oblique CTA screenshot is not proof that those acquisition requirements or clinical sizing criteria are satisfied.
- The six existing reported inputs do not include every shape/indication/clinical context field. Do not silently select SL/SLS, round to a SKU, infer a neck ratio or claim complete compatibility from the approximation alone.
- This37-row portfolio/source normalization is not yet integrated into the application's catalog/calculation versions. The existing historical sizing result was not relabeled current, recalculated or populated with invented dimensions.

## Attribution repair

WEB uses the **Terumo Neuro/MicroVention** source channel. The earlier Medtronic/Sequent-acquisition attribution and attempted Medtronic-library WEB searches were wrong and are rejected. The raw child audit is retained as incoming, superseded evidence, not a canonical catalog source.
