# HDP Research Fanout Engine v0002

A versioned Great Venture Runtime subsystem that turns one canonical evidence object into multiple doorway-specific staged market assets without rewriting the existing specialist agents.

## Runtime target

- Path: `C:\HDP\VentureRuntime\surfaces\content\v0002`
- Service: `HDP-CONTENT-V0002`
- Bind: `127.0.0.1:4321`
- Lifecycle at creation: `BUILD`
- Startup: `Manual`
- Public binding: none

v0001 is preserved. v0002 is a new version rather than an overwrite.

## Fanout doorways

1. Highest Degree Priorities (`hdp-core`)
2. Enterprise Systems Factory (`esf`)
3. Virtual Market Insight (`vmi`)
4. Research-Based Outreach (`outreach`)

A doorway receives its own buyer perspective, allowable asset types, CTA hypothesis, and publication target. The same article is never blindly syndicated across every site.

## Agent model

Existing agents remain independent services/tools.

- **OIE:** v0002 can collect current demand/capability context through read-only HTTP GET operations.
- **CCAO:** v0002 can execute the existing deterministic local gate when a research object contains `ccao_input`.
- **SEO Agent:** health/probe adapter exists; mutation/build work stays contract-gated.
- **WebDev Agent:** the known `/api/v8/webdev/build` seam is registered but is not automatically invoked.
- **GitHub:** publication targets are stored in doorway manifests, but v0002 has no publish endpoint.

## Workflow

`research -> optional read-only enrichment -> fanout plan -> staged assets -> agent task envelopes -> validation -> explicit operator approval -> future publisher version`

Each staged asset receives:

- `draft.md`
- `manifest.json`
- `agent_tasks.json`

Research lineage is preserved by `research_id`, `plan_id`, and `asset_id`.

## Safety invariants

- `publish_enabled=false`
- `auto_publish=false`
- `external_action_allowed=false`
- no GitHub push from the runtime
- no email send
- no LinkedIn post
- no public web deployment
- no existing agent code modification
- private entity names are not copied into staged drafts by default

## Native API

- `GET /health`
- `GET /api/state`
- `GET /api/v1/doorways`
- `GET /api/v1/adapters`
- `GET /api/v1/plans`
- `GET /api/v1/assets`
- `POST /api/v1/research`
- `GET /api/v1/research/{research_id}`
- `POST /api/v1/research/{research_id}/enrich`
- `POST /api/v1/research/{research_id}/fanout`
- `POST /api/v1/plans/{plan_id}/stage`

## v0001 compatibility

- `POST /api/plans`
- `POST /api/plans/{plan_id}/stage`

These compatibility routes retain the staged-only safety boundary while converting the request into the v0002 canonical research/plan model.
