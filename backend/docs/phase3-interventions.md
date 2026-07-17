# Phase 3 Interventions

Phase 3 records bounded human evidence about actions taken in response to an Issue. An Issue remains the machine-observed performance condition; an Intervention is a human assertion that an action occurred. Recording an Intervention never resolves an Issue, changes its severity, or claims that Meta confirmed the action.

## Action Evidence

V1 supports campaign pause/resume, budget, creative, targeting, exclusion, bid strategy, tracking, landing-page, monitoring, no-action, internal-note, and bounded other actions. Each action has a strict versioned payload. The authenticated recorder may attribute performance to themselves, another active workspace member, or a manually named external performer. Actor, Issue, Client, account, campaign, Report, ReportRun, and latest Signal identity is captured into immutable bounded snapshots using persisted evidence only.

Writes require an active WorkspaceMember, a non-archived Client, the current Client-to-Meta-account assignment, consistent campaign lineage, the Client lifecycle lease, and a transaction-capable MongoDB deployment. A revoked Meta connection alone does not invalidate human evidence, and no Intervention path calls Meta.

## Corrections And Cancellations

Interventions are not edited or deleted. A correction supersedes one active Intervention by creating a new immutable successor that inherits the original evidence snapshots. A cancellation transitions one active Intervention to cancelled and appends write-once cancellation evidence. Only the original recorder or workspace owner may correct or cancel.

Agency-scoped idempotency keys and semantic request hashes make creation, correction, and cancellation retries deterministic. The idempotency key is not part of the semantic hash and is never returned by public serializers.

## Issue Cache And Audit

Issue history remains authoritative in the Intervention collection. `latest_intervention_id`, `intervention_count`, `last_intervention_at`, and `intervention_revision` are transactional summary caches only. Intervention operations do not mutate Issue lifecycle fields or `lifecycle_revision`.

Each write records a transactional Activity event containing bounded identifiers, action type, summary, and immutable recorder display name. Activity remains secondary audit evidence.

## Index Operations

The Intervention model declares eight exact Phase 3 indexes. Normal startup only inspects readiness and never creates or drops indexes. Critical writes fail closed until the exact index inventory has been verified. Operators can run `npm run inspect:phase3-intervention-indexes` or explicitly apply missing non-conflicting indexes with `npm run apply:phase3-intervention-indexes`. The manager never drops indexes or calls `syncIndexes`.

There is no historical Intervention migration: past human action cannot be inferred reliably from Signals, recommendations, report prose, Activity, or email. Phase 4 may evaluate outcomes after an Intervention, but outcome scoring and causal attribution are deliberately outside Phase 3.
