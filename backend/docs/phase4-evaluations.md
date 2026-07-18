# Phase 4 Evaluations

An Evaluation is an immutable, versioned comparison of bounded persisted ReportRun evidence around a recorded Intervention. It describes metric movement observed after the recorded action only. It does not attribute that movement to the action and does not label an action a success or failure.

## Evidence and windows

Future ReportRuns persist `evaluation_evidence` built from rows already fetched and validated during normal execution. It contains additive campaign totals, deterministically recalculated rates, exact scheduled windows, cadence, timezone, currency, attribution windows returned for the actual Insights request, and Meta binding revision. Missing attribution limits conversion-family metrics only. It excludes raw rows, reach, frequency, narrative, HTML, and delivery data.

The baseline is the latest complete cadence-matched window ending before the Intervention's local action date and within the cadence freshness limit. The follow-up is one canonical equal-duration window beginning the day after the local action date. The action date is excluded. Daily, weekly, and monthly windows use 1, 7, and 30 days. Historical fallback and arbitrary manual windows are ineligible.

## Metrics

V1 supports CTR, CPC, CPM, CPA, ROAS, conversions, conversion value, and conversion rate as primary metrics. Clicks may be watched directionally. Spend and impressions are context only. Reach and frequency are not evaluated. Thresholds and minimum evidence are centralized in `phase4Evaluation.domain.js`; minimum evidence is checked before material movement.

Conversion metrics require explicit matching attribution windows. Currency-sensitive metrics require the same currency. A `mixed` result requires conflicting material movement across at least two valid directional watched metrics; neutral context cannot produce it.

Materiality requires both the configured relative floor and the configured absolute floor. Equality counts as material: both comparisons use `>=`. Movement below either floor is classified as `no_material_change`. For count and value metrics with a zero baseline, the absolute floor is the materiality authority because a relative change is undefined. Rates and ratios with an invalid denominator are `insufficient_data` and are not classified as material movement.

## Versioning and lifecycle

`EvaluationSeries` is the mutable lease and current-version authority. Recalculation writes nothing when rule version and evidence hash are unchanged. Changed evidence appends a new immutable `Evaluation`, references its predecessor, and advances the Series transactionally. Older versions are exposed with a derived `superseded` status without mutation.

Corrections and cancellations append an invalidated version to the affected series and preserve all earlier evidence. The correction successor has its own independently resolved intent and Series. Correction-chain predecessors are collapsed for overlap checks; a separate qualifying action on the same campaign inside the follow-up window makes the Evaluation not evaluable.

Overlap candidates are queried across the exact inclusive-start/exclusive-end UTC interval. Evaluation recovery uses bounded `_id` cursor pagination. ReportRun continuation is persisted on the ReportRun, and periodic reconciliation stores its checkpoint in `evaluation_reconciliation_checkpoints`, so interrupted work resumes after process restart without an unbounded loop.

Evaluation history rejects all updates, replacements, deletes, and bulk writes at the model boundary. EvaluationSeries and Intervention bulk writes are also rejected; approved Series leases and Intervention lifecycle/evaluation fences remain explicit query operations.

## Processing and refresh

ReportRun processing persists evidence and completes Signal/Issue matching before attempting Evaluation work. Evaluation failures are isolated from Report completion and all delivery behavior. Processing uses the Client lifecycle lease, a token-owned EvaluationSeries lease, a required transaction, account binding fences, CAS advancement, and deterministic idempotency.

Manual refresh uses persisted evidence only. It never calls Meta, runs a Report, starts the scheduler, or invokes delivery. It requires an active member who is the original recorder or workspace owner, an active Intervention and Client, expected revision, idempotency key, exact index readiness, and a persisted 60-second bucket.

## APIs and indexes

The API exposes agency-scoped Intervention history, Evaluation detail, approved-filter workspace history, and manual refresh. Archived history remains readable while archived writes are blocked. Serializers exclude request hashes, idempotency keys, lease state, actor email, tokens, raw rows, internal errors, and delivery artifacts.

Twelve exact guarded indexes support history, approved filters, idempotency, immutable successor lineage, ReportRun convergence, Series uniqueness, and lease expiry. Startup inspection never mutates indexes; writes fail closed until readiness is exact. The explicit CLI can inspect or apply missing exact indexes, never drops or renames indexes, and refuses conflicts.

There is no Evaluation migration, Intervention rewrite, or ReportRun evidence backfill. Legacy documents remain readable and historical fallback evidence remains ineligible. Causal attribution, significance testing, Issue auto-resolution, recommendations, tasks, LLM evaluation, and destructive deletion are deferred.
