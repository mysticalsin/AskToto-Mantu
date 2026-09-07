# Brand logo overrides

Twelve of the 28 connector kinds in the catalog do not have an entry in the `simple-icons`
package (some real brands were removed from it after trademark takedown requests; two,
`custom-mcp` and `custom-rest`, never had a brand to begin with). `operator/scripts/build-assets.mjs`
generates a monogram for those instead: the ten with a real, publicly documented brand colour get
that colour with a white initial; the two with no real brand keep the app's own accent colours.

## Dropping in a real brand mark

Save the vendor's own SVG logo here as `<kind>.svg`, using the exact kind id from
`src/shared/operator-connectors.ts`'s `CONNECTOR_KINDS` (for example `salesforce.svg`,
`slack.svg`, `microsoftteams.svg`). The next run of `node operator/scripts/build-assets.mjs`
copies it verbatim into `operator/public/logos/<kind>.svg`, overriding whatever it generated
(brand colour monogram or otherwise) for that kind. Nothing else needs to change: the catalog,
the connectors page, and every render primitive already read from `operator/public/logos/`.

Kinds that can use this today (generated as a monogram as of this writing): `salesforce`,
`pipedrive`, `dynamics365`, `attio`, `close`, `monday`, `freshdesk`, `sharepoint`, `slack`,
`microsoftteams`, `custom-mcp`, `custom-rest`.

## What to drop, and what not to

- A single `<svg>` file, the vendor's own official mark (their brand/press page, not a
  screenshot or a redraw). No PNG, no JPEG -- the rest of the catalog is all SVG for crisp
  rendering at every size.
- Prefer a version that reads well on a small (28-32px) square tile, on both a light and a dark
  page background, since connectors render on both themes.
- **Brand marks stay the vendor's property.** Dropping a logo in here for Métis Operator's own
  internal use does not transfer, license, or waive anyone's trademark. Do not redistribute
  these files outside this product, and remove one immediately if the vendor ever asks.
- This directory is a build input, not build output: it is never itself served publicly, and
  `git`-ignoring it is fine if a logo should not be committed to the repo (some vendors' brand
  guidelines are stricter than others).
