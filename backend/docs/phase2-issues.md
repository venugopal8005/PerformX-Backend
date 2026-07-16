# Phase 2 Issues

Historical migration applies one canonical fingerprint group per transaction.
If a later group fails, earlier committed groups remain valid; apply is safely
restartable because already-linked Signals are skipped and every completed
group is revalidated from persisted lineage.

## Signal and Issue

A Signal is immutable evidence from one ReportRun. An Issue groups eligible
negative Signals that share one canonical campaign-level identity. Legacy,
positive, ambiguous, malformed, stale, and duplicate Signals are retained but
are not guessed into an Issue.

## Identity

The V1 fingerprint is SHA-256 over an ordered, versioned scope containing the
workspace, Client, Meta account, campaign, archetype, metric family, cadence,
and persisted timezone. Report names, campaign names, severity, Report IDs,
and timestamps are not identity. A hash match is always followed by a full
canonical-scope comparison.

## Lifecycle

Issues are `open`, `monitoring`, or `resolved`. New negative observations reset
the absence streak. Two distinct, newer, trustworthy clean scheduled windows
resolve an Issue. Recurrence within 30 days reopens it; later recurrence creates
a successor linked by `predecessor_issue_id`. Stale and duplicate windows never
advance lifecycle state.

## Matching and Concurrency

Issue processing runs after ReportRun and Signal persistence and before
delivery. A five-minute token-owned ReportRun claim and required MongoDB
transaction atomically update the Issue, Signal lineage, and stage completion.
The active-fingerprint and Signal-occurrence unique indexes resolve concurrent
creation safely. Integrity conflicts fail closed before delivery.

## Indexes and Migration

`applyPhase2IssueIndexes.js` inspects by default and creates only missing exact
indexes with explicit `--apply`; it never drops indexes. Issue processing stays
disabled when critical uniqueness indexes are absent.

`migratePhase2Issues.js` is dry-run by default. Apply requires explicit expected
eligible, group, and legacy-ungrouped counts. Eligible Signals are replayed in
chronological fingerprint groups, one transaction per group. The migration
does not replay clean windows or infer missing historical identity.

## Deferred

Phase 3 owns interventions, user action tracking, outcome evaluation, playbooks,
advanced recurrence analytics, and learned recommendations. Phase 2 stores no
artifact bodies, raw engine output, or delivery secrets in Issues.
