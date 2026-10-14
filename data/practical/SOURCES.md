# Practical fixture sources

`athens.json` contains the 14 independently collected Wikidata candidate records from the parent preparation dataset. Source claims, category classifications, administrative memberships, source QIDs, revisions, retrieval dates, and CC0 declarations are preserved. Dataset license: CC0, per [Wikidata licensing](https://www.wikidata.org/wiki/Wikidata:Licensing).

`athens-reference.json` preserves the single non-deprecated Wikidata P625 coordinate statement for Q1524 with source revision, precision, retrieval date, and CC0 attribution. It is used only as a source-reported straight-line radius reference point. It is not a verified city centroid, boundary, or walking origin.

No Qloo identifiers, responses, matches, ranks, or private linkage are present. Fourteen original records have no reliable Qloo identity bindings. A record without an exact backend-supplied `InternalCandidate.fixtureId` match is ineligible. The National Museum of Contemporary Art's conflicting coordinate statements remain represented as `coordinates: null` in the practical fixtures; no convenient coordinate was selected.

Every source-reported city/category claim describes the independent Wikidata statement only. Coordinates, category, and city classification do not establish present operation, business hours, prices, menu, accessibility, availability, safety, or booking facts. Unknown and conflicting data cannot satisfy hard constraints.
