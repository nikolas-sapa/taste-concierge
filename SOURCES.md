# Source inventory

- Original application: MIT, `LICENSE`.
- Independent practical facts: Wikidata CC0, record-level provenance in `data/practical/athens.json`; reference origin separately sourced. See `data/practical/SOURCES.md`.
- UI control adaptations: shadcn/ui MIT attribution in `src/ui/SOURCES.md`.
- Framework/runtime: exact Next, React, React DOM and server-only pins in `package.json` and `package-lock.json`, upstream MIT packages. TypeScript Apache-2.0, Vitest MIT, Playwright Apache-2.0, DefinitelyTyped types MIT.
- Geist Sans: Next font loader; upstream SIL Open Font License 1.1. Font served by the framework locally after build.
- Qloo service: official event guide https://docs.qloo.com/reference/qloo-llm-hackathon-developer-guide. Native HTTP integration. No SDK/harness/starter copied. Captured service data and linkages remain private, subject to Qloo terms.
- Proposed model service: OpenAI Responses, separately gated. No generated output or paid calls included as fixtures.
- OSM: no dataset adopted. Repair requests failed; prospective ODbL support does not license or establish a populated dataset.

No dependency or database license transfers ownership of entrant-created code or service responses.
