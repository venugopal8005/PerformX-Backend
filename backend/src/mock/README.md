# Narrative Mock Meta Ads Data

Use this to test the Narrative engine without running live ads.

## Files

- `narrativeMockMetaScenarios.js` - importable JS module.
- `narrative_mock_meta_scenarios.json` - same data as JSON.
- `narrative_mock_meta_rows.csv` - flat CSV for viewing/editing.

## Usage

Generate a formatted email report from a mock scenario:

```bash
node backend/src/mock/runMockReportEmail.js veryBadSignal
```

This writes:

- `backend/src/mock/generated/veryBadSignal-report.html`
- `backend/src/mock/generated/veryBadSignal-payload.json`

Open the HTML file in a browser to preview the exact report email.

List available scenarios:

```bash
node backend/src/mock/runMockReportEmail.js --list
```

Send the mock report through an email/n8n webhook:

```bash
MOCK_REPORT_WEBHOOK_URL="https://your-n8n-webhook-url" \
MOCK_REPORT_RECIPIENT="you@example.com" \
node backend/src/mock/runMockReportEmail.js veryBadSignal --send
```

The backend report runner itself does not send email directly. It generates `emailSubject` and `emailHtml`; n8n or another mailer must deliver that payload.

Direct engine-only usage:

```js
import { generatePerformanceNarrative } from "../../performanceNarratorEngine.js";
import scenarios from "./narrativeMockMetaScenarios.js";

const scenario = scenarios.veryBadSignal;

const narrative = generatePerformanceNarrative(
  scenario.rows,
  scenario.options
);

console.log(narrative);
```

## Scenario expectations

1. `goodSignal`
   - should produce opportunity / healthy scaling style output.
   - use for landing page positive sample.

2. `moderateSignal`
   - should produce review-today / auction pressure style output.
   - useful to test non-panic reporting.

3. `veryBadSignal`
   - should produce action-needed / creative fatigue style output.
   - useful for landing page “critical report” sample.

All rows include daily breakdown, campaign/adset/ad identifiers, spend, impressions, reach, clicks, CTR, CPC, CPM, frequency, actions, and cost-per-action data.
