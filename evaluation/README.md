# Offline evaluation preflight

`npm run evaluate` validates the frozen public profiles, rubric, and named case counts, then writes an aggregate-only `public-summary.json`. Default mode never reads private files, Qloo data, credentials, model outputs, or browser state; it makes no network calls. It reports T1–T7 as blocked with zero observed cases until independently generated and reviewed real evidence exists.

Synthetic geometry/filter unit tests are not acceptance results. They cannot populate or alter this summary. No receipt-ingestion format is defined in this iteration. Root owns future receipt production and trust review after successful application journeys exist. Do not manually edit a target to passed or move raw Qloo responses into this directory.

Frozen ablation uses the predeclared P01–P10 order, treatment-first on odd profiles and baseline-first on even profiles. Human presentation places treatment left for P02, P03, P06, P08, and P09, right for the others. This is counterbalancing, not randomization. Failed generations must remain in completion denominators; an absent output receives no subjective score. No minimum improvement is required. See `rubric.json` and `cases.json`.
