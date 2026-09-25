# HDP Research Fanout Engine v0001

Evidence-to-market-asset orchestration for the Great Venture Runtime.

## Runtime

- Runtime path: `C:\HDP\VentureRuntime\surfaces\content\v0001`
- Service: `HDP-CONTENT-V0001`
- Bind: `127.0.0.1:4320`
- Lifecycle: `BUILD`
- Startup: `Manual`

## What v0001 does

1. Stores one canonical research object.
2. Scores registered commercial doorways against that research.
3. Chooses an appropriate asset type per doorway.
4. Generates a doorway-specific staged draft scaffold and machine-readable manifest.
5. Preserves research lineage from source research to every generated asset.
6. Provides adapter definitions for OIE, SEO Agent, WebDev Agent and GitHub.

## Safety invariants

- Publication is disabled.
- Existing specialist agents are not modified.
- Adapter invocation is disabled until their contracts are explicitly verified.
- All generated assets have `publish_allowed=false`.
- GitHub publication is staged only; no push occurs from v0001.
- No outbound email, social post or public deployment occurs.
- Runtime research data and SQLite state stay on the VPS and are not committed here.

## Initial doorways

- Enterprise Systems Factory — `grandopenauto/enterprisesystemsfactory`
- Highest Degree Priorities — `grandopenauto/highestdegreepriorities`
- Virtual Market Insight — `grandopenauto/virtualmarketinsight`

## API

- `GET /health`
- `GET /api/v1/doorways`
- `GET /api/v1/adapters`
- `POST /api/v1/research`
- `GET /api/v1/research/{research_id}`
- `POST /api/v1/research/{research_id}/fanout`
- `GET /api/v1/assets`

The fanout endpoint writes staged assets under `staging\<research_id>\<asset_id>`.
