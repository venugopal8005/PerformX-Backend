# Phase 1E History Index Operations

Use this sequence during an approved production maintenance window.

Normal application startup disables Mongoose automatic index and collection creation. Schema
index declarations document the expected indexes but do not apply them. Use the guarded
maintenance command below to apply Phase 1E history indexes. Execution-integrity indexes remain
managed by their existing explicit startup mechanism.

1. Inspect the current index inventory. This is read-only.

   ```bash
   npm run inspect:phase1e-history-indexes
   ```

2. Review every classification and resolve any reported conflict before applying.

3. In an approved low-traffic window, create only missing indexes.

   ```bash
   npm run apply:phase1e-history-indexes
   ```

4. Inspect again.

   ```bash
   npm run inspect:phase1e-history-indexes
   ```

5. Re-run the Phase 1E production query-plan audit.

Apply mode creates missing indexes sequentially and verifies the final inventory. It does not
drop, rename, replace, or synchronize indexes, and it does not modify documents. Monitor
MongoDB I/O, storage, replication health, and application latency while indexes build.

Rollback requires explicit manual review. This script never drops newly created indexes
automatically.
