# Narrative Backend Playbook

This is the dumb-friendly guide to the backend.

Think of this file as your map when you forget what talks to what.

## 1. The One Sentence Version

Narrative is a backend that helps an agency monitor Meta Ads performance for its clients, detect useful performance signals, store those signals, store activity history, and prepare report/email data for n8n to send.

## 2. The Big Picture

The backend is built around this ownership model:

```txt
Agency
  Users
  Clients
    Meta Connections
    Reports
      Signals
      Activities
```

Simple meaning:

- An `Agency` is the workspace.
- A `User` belongs to one agency.
- A `Client` belongs to one agency.
- A `MetaConnection` belongs to one agency and one client.
- A `Report` belongs to one agency and one client.
- A `Signal` belongs to one agency, one client, and usually one report.
- An `Activity` belongs to one agency and can also point to a client, report, and user.

The most important rule:

```txt
Agency is the owner.
User is not the owner.
```

So when you fetch reports, clients, signals, or activities, the backend should always ask:

```txt
Which agency is this user inside?
```

That agency id comes from the auth token as:

```js
req.user.agencyId
```

## 3. The Brain Flow

This is the current operational engine flow:

```txt
n8nScheduler
  calls n8n every minute

n8n workflow
  calls backend /api/reports/run-all

run-all controller
  calls runDueReports()

reportRunner.service.js
  finds due active reports
  fetches Meta metrics
  creates comparison windows
  compares current vs previous metrics
  sends clean data to narrator engine
  saves signals
  saves activities
  updates report summary
  updates last_run_at
  updates next_run_at
  returns email HTML/data for n8n
```

The simplest mental model:

```txt
Time Window Aggregator
        |
        v
Normalized Comparison Dataset
        |
        v
Central Narrator Engine
        |
        v
Signals
Activities
Summaries
Insights
Recommendations
Email HTML
```

Important:

The narrator engine should not care if the report is daily, weekly, or monthly.

The narrator engine only needs this:

```js
{
  currentPeriodMetrics,
  previousPeriodMetrics,
  deltas
}
```

The report runner and time window service decide what "current" and "previous" mean.

## 4. n8n Is Still Part Of The System

Do not remove n8n.

The current idea is:

- Backend knows the data.
- Backend knows when reports are due.
- Backend generates the intelligence and email payload.
- n8n acts like the outside automation tool that calls the backend and sends the email.

So:

```txt
n8n = clock and delivery helper
backend = brain and database
```

## 5. Folder Map

### `backend/src/server.js`

This starts the backend.

It does these things:

- starts the n8n scheduler
- creates the Express app
- enables CORS
- enables JSON request bodies
- enables cookies
- mounts all backend routes
- connects to MongoDB
- mounts the auth module
- starts listening on the port

Mounted routes:

```txt
/api/tasks
/api/meta
/api/reports
/api/clients
/api/signals
/api/activities
/api/auth
/api/health
```

Note:

`/api/auth` is mounted by `initAuth({ app, db: mongoose })` from the auth module.

### `backend/src/models`

Database schemas live here.

These files define what gets stored in MongoDB.

### `backend/src/controllers`

Controllers receive API requests.

They are the first backend function hit by an endpoint.

Example:

```txt
POST /api/reports/create
  goes to createReport()
```

### `backend/src/services`

Services contain reusable business logic.

This is where the serious backend work happens.

Example:

```txt
reportRunner.service.js
  actually runs reports
```

### `backend/src/routes`

Routes connect URLs to controllers.

### `backend/src/jobs`

Background jobs live here.

Right now this includes the n8n scheduler.

### `backend/src/utils`

Small helper functions live here.

### `backend/performanceNarratorEngine.js`

This is the rule-based narrator brain.

It is not GPT yet.

It reads performance metrics and returns:

- executive summary
- user insight
- likely cause
- recommendations
- severity
- ranked anomalies
- decision brief
- monitoring plan
- guardrails

## 6. Models

### Agency

File:

```txt
backend/src/models/Agency.js
```

Collection:

```txt
agencies
```

What it means:

An agency is a workspace.

Example:

```txt
Apex Media Group
```

Important fields:

- `name`
- `slug`
- `created_by`

Important behavior:

- Automatically creates a slug from the name.
- Keeps slug unique.

Example:

```txt
Apex Media Group
becomes
apex-media-group
```

### User

File:

```txt
backend/src/models/User.js
```

Collection:

```txt
users
```

What it means:

A person who logs in.

Important fields:

- `agency_id`
- `full_name`
- `email`
- `password_hash`
- `google_id`
- `role`
- `avatar_url`

Roles:

```txt
owner
admin
analyst
```

Important behavior:

- Passwords are hashed with bcrypt before saving.
- `comparePassword(password)` checks login password.
- Virtual aliases exist so auth-module names still work:
  - `agencyId` maps to `agency_id`
  - `fullName` maps to `full_name`
  - `passwordHash` maps to `password_hash`
  - `googleId` maps to `google_id`
  - `avatar` maps to `avatar_url`

Why that matters:

The backend model uses snake_case.

The auth module still uses some camelCase.

The virtuals help both styles work together.

### Client

File:

```txt
backend/src/models/Client.js
```

Collection:

```txt
clients
```

What it means:

A client is one brand/account/customer inside an agency.

Important fields:

- `agency_id`
- `name`
- `industry`
- `status`
- `notes`
- `created_by`

Status values:

```txt
stable
moderate
critical
```

Example:

```txt
Agency: Apex Media Group
Client: Glow Skin Co
```

### MetaConnection

File:

```txt
backend/src/models/MetaConnection.js
```

Collection:

```txt
meta_connections
```

What it means:

This stores the Meta Ads connection for a client.

Important fields:

- `agency_id`
- `client_id`
- `business_id`
- `ad_account_id`
- `ad_account_name`
- `access_token`
- `token_expires_at`
- `is_active`
- `connected_by`

Important:

The Meta connection belongs to the agency and client.

It does not belong to the user.

The user is only stored as `connected_by`.

### Report

File:

```txt
backend/src/models/Report.js
```

Collection:

```txt
reports
```

What it means:

A report is an operational monitor.

It is not only an email.

It tells the backend:

- which client to monitor
- which campaigns to monitor
- how often to run
- who receives the output
- when to run next

Important fields:

- `agency_id`
- `client_id`
- `created_by`
- `name`
- `type`
- `status`
- `severity`
- `recipients`
- `monitored_campaigns`
- `last_summary`
- `last_signal_at`
- `next_run_at`
- `last_run_at`
- `schedule`

Report types:

```txt
daily
weekly
monthly
```

Report status:

```txt
active
paused
```

Schedule rules:

- Daily report does not need `day_of_week` or `day_of_month`.
- Weekly report needs `day_of_week`.
- Monthly report needs `day_of_month`.

### Signal

File:

```txt
backend/src/models/Signal.js
```

Collection:

```txt
signals
```

What it means:

A signal is one important thing the backend detected.

Examples:

- CTR is dropping.
- ROAS dropped.
- CPM spiked.
- Frequency spiked.
- Creative fatigue likely.
- Delivery volume dropped.

Important fields:

- `agency_id`
- `client_id`
- `report_id`
- `campaign_id`
- `type`
- `severity`
- `title`
- `description`
- `recommendation`
- `metadata`
- `detected_at`

Severity:

```txt
stable
moderate
critical
```

Important:

Signals are derived from the narrator engine output.

Do not create a second separate signal brain somewhere else.

### Activity

File:

```txt
backend/src/models/Activity.js
```

Collection:

```txt
activities
```

What it means:

An activity is a timeline event.

Examples:

- Client created
- Meta connected
- Report created
- Report started
- Report executed
- Signal detected
- Decision generated
- Report failed

Important fields:

- `agency_id`
- `client_id`
- `report_id`
- `user_id`
- `type`
- `title`
- `description`
- `severity`
- `metadata`

Activities power:

- activity feed
- client timeline
- report timeline
- audit history
- right sidebar updates

### Task

File:

```txt
backend/src/models/tasks/task.model.js
```

This is older app logic.

It is still user-owned:

```txt
owner: User
```

That is okay for now, but remember:

Tasks are old module behavior.

The new operational intelligence system should be agency-based.

## 7. Services

### reportRunner.service.js

File:

```txt
backend/src/services/reportRunner.service.js
```

This is the conductor.

It runs the full operational report process.

Main functions:

```js
runReport(reportId, options)
runDueReports(options)
getRecentReportActivities(reportId)
```

What `runReport()` does:

```txt
1. Load report from MongoDB
2. Check agency access if agencyId was provided
3. Skip if report is paused
4. Skip if report is not due yet
5. Load active Meta connection for the report client
6. Check token is not expired
7. Check ad account is selected
8. Build comparison windows
9. Fetch current Meta metrics
10. Fetch previous Meta metrics
11. Compare metrics
12. Call central narrator engine
13. Save signals from narrator output
14. Save activities
15. Update report last_summary
16. Update report last_signal_at
17. Update report severity
18. Update last_run_at
19. Calculate next_run_at
20. Build email subject and HTML
21. Return payload for controller/n8n
```

What `runDueReports()` does:

```txt
1. Find reports where:
   status = active
   next_run_at <= now
2. Run each due report
3. If one report fails, record a report_failed activity
4. Continue running the others
```

### timeWindowAggregator.service.js

File:

```txt
backend/src/services/timeWindowAggregator.service.js
```

This decides what time windows to compare.

Main function:

```js
getComparisonWindows(type, options)
```

Daily:

```txt
current = today
previous = yesterday
```

Weekly:

```txt
current = last 7 days
previous = previous 7 days
```

Monthly:

```txt
current = last 30 days
previous = previous 30 days
```

Important:

This service handles report frequency.

The narrator engine does not.

### metaInsights.service.js

File:

```txt
backend/src/services/metaInsights.service.js
```

This talks to Meta Graph API.

Main functions:

```js
fetchMetaInsights()
normalizeMetaInsightRow()
aggregateMetaMetrics()
```

What it fetches:

- impressions
- clicks
- ctr
- cpc
- spend
- reach
- frequency
- cpm
- actions
- action values
- purchase ROAS
- cost per action

What it returns:

```js
{
  rows,
  metrics,
  paging
}
```

Where:

- `rows` are raw-ish Meta rows
- `metrics` are clean aggregated totals
- `paging` is Meta paging data

### metricComparison.service.js

File:

```txt
backend/src/services/metricComparison.service.js
```

This compares current metrics against previous metrics.

Main functions:

```js
calculatePercentChange(current, previous)
compareMetrics(currentMetrics, previousMetrics)
compareDailyMetrics()
compareWeeklyMetrics()
compareMonthlyMetrics()
```

Example:

```txt
previous CTR = 2.00
current CTR = 1.60
change = -20%
```

It handles zero safely:

```txt
previous 0 and current 0 = 0%
previous 0 and current positive = 100%
```

### performanceNarratorEngine.js

File:

```txt
backend/performanceNarratorEngine.js
```

This is the central brain.

It has two important entry points:

```js
generatePerformanceNarrative()
generateOperationalInsight()
```

`generatePerformanceNarrative()` is the older daily-row style function.

`generateOperationalInsight()` is the newer period-agnostic function.

That means it can work for:

- daily
- weekly
- monthly
- future quarterly

It only cares about:

```js
{
  currentPeriodMetrics,
  previousPeriodMetrics,
  deltas
}
```

It returns a rich object with:

- `executiveSummary`
- `userInsight`
- `likelyCause`
- `financialImpact`
- `recommendations`
- `diagnosticChecks`
- `monitoringPlan`
- `guardrails`
- `severity`
- `metrics`
- `rankedAnomalies`
- `adDiagnostics`

Important:

This is not AI generation yet.

It is deterministic rule-based intelligence.

### signalGenerator.service.js

File:

```txt
backend/src/services/signalGenerator.service.js
```

This turns narrator output into database signals.

Main functions:

```js
buildSignalsFromNarrative()
saveSignalsFromNarrative()
```

Important:

This service should not invent its own separate intelligence.

It should read the narrator output and translate it into `Signal` documents.

Example:

Narrator says:

```txt
Creative fatigue is likely.
Severity is high.
```

Signal generator stores:

```txt
type = creative_fatigue
severity = critical
title = narrator headline
description = narrator summary
recommendation = narrator primary action
metadata = narrator evidence and metrics
```

### activityRecorder.service.js

File:

```txt
backend/src/services/activityRecorder.service.js
```

This saves timeline events.

Main functions:

```js
recordActivity()
recordSignalActivities()
```

Use this whenever something important happens.

Examples:

- report created
- report started
- report executed
- signal detected
- decision generated
- report failed
- Meta connected
- client created

### generateMetaReport.service.js

File:

```txt
backend/src/services/generateMetaReport.service.js
```

This is a wrapper around `runReport()`.

It is used when something needs a complete report payload.

Example:

Manual send calls this.

It returns:

- report id
- report name
- agency id
- client id
- recipients
- ad account
- narrative
- signals
- activities
- email subject
- email HTML
- comparison data

### reportSchedule.js

File:

```txt
backend/src/utils/reportSchedule.js
```

This calculates schedule details.

Main functions:

```js
normalizeReportSchedule()
getNextRunAt()
```

It validates:

- frequency/type must be daily, weekly, or monthly
- time must be `HH:mm`
- timezone must be valid
- weekly reports need day of week
- monthly reports need day of month

It returns the next time a report should run.

### performanceEmailFormatter.js

File:

```txt
backend/src/utils/performanceEmailFormatter.js
```

This formats narrator output into email HTML.

Main functions:

```js
formatPerformanceEmail()
formatPerformanceEmailSubject()
```

It does not send the email.

It only builds the email subject and HTML.

n8n handles delivery.

### controllerLogger.js

File:

```txt
backend/src/utils/controllerLogger.js
```

This logs controller/service actions in a cleaner way.

Important:

It redacts sensitive values like:

- token
- access_token
- cookie
- password
- secret

### n8nScheduler.js

File:

```txt
backend/src/jobs/n8nScheduler.js
```

This runs every minute.

It calls the n8n webhook.

That n8n workflow is expected to call the backend `/api/reports/run-all` endpoint.

Important:

This is why we did not add a separate internal cron runner.

You already have n8n as the scheduling trigger.

## 8. Endpoints

Base URL locally is usually:

```txt
http://localhost:3000
```

So:

```txt
/api/health
```

means:

```txt
http://localhost:3000/api/health
```

## 9. Auth Endpoints

These come from the auth module.

Base:

```txt
/api/auth
```

### POST `/api/auth/register`

Creates:

```txt
Agency
Owner User
JWT cookie
```

Body example:

```json
{
  "agencyName": "Apex Media Group",
  "fullName": "Venu",
  "email": "venu@example.com",
  "password": "password123"
}
```

What happens:

```txt
1. Validate fields
2. Check user does not already exist
3. Create agency
4. Create user
5. Hash password
6. Set user role as owner
7. Generate token with userId, agencyId, role
8. Set token cookie
9. Return user
```

### POST `/api/auth/login`

Logs in an existing user.

Body example:

```json
{
  "email": "venu@example.com",
  "password": "password123"
}
```

What happens:

```txt
1. Find user by email
2. Compare password with bcrypt
3. Generate token
4. Set cookie
5. Return user
```

### POST `/api/auth/google`

Google signup/login helper.

Body example:

```json
{
  "agencyName": "Apex Media Group",
  "name": "Venu",
  "email": "venu@example.com",
  "googleId": "google-user-id",
  "avatar": "https://example.com/avatar.png"
}
```

What happens:

```txt
1. If user exists and already has agency, log them in
2. If user has no agency, require agencyName
3. Create agency if needed
4. Create or update user
5. Return token
```

### GET `/api/auth/me`

Returns the current logged-in user.

Requires cookie token.

### POST `/api/auth/logout`

Clears the auth cookie.

### POST `/api/auth/refresh`

Refreshes the JWT cookie.

## 10. Client Endpoints

Base:

```txt
/api/clients
```

All client routes are protected.

They need the auth cookie.

### POST `/api/clients`

Creates a client inside the logged-in user's agency.

Body example:

```json
{
  "name": "Glow Skin Co",
  "industry": "Beauty",
  "status": "stable",
  "notes": "Main ecommerce client"
}
```

What happens:

```txt
1. Read agencyId from token
2. Create client
3. Record client_created activity
4. Return client
```

### GET `/api/clients`

Gets all clients for the current agency.

### GET `/api/clients/:clientId`

Gets one client, but only if it belongs to the current agency.

### PATCH `/api/clients/:clientId`

Updates a client.

Can update:

- name
- industry
- notes
- status

## 11. Meta Endpoints

Base:

```txt
/api/meta
```

These routes connect and read Meta Ads data.

All current Meta routes are protected.

### GET `/api/meta/connect?client_id=CLIENT_ID`

Starts Meta OAuth.

What happens:

```txt
1. Read agencyId from token
2. Read client_id from query
3. Build Meta OAuth URL
4. Encode agencyId, clientId, userId into state
5. Redirect user to Facebook OAuth
```

### GET `/api/meta/callback`

Meta redirects here after OAuth.

What happens:

```txt
1. Read code from Meta
2. Decode state to recover agencyId and clientId
3. Exchange short token
4. Exchange long-lived token
5. Save MetaConnection
6. Record meta_connected activity
7. Redirect back to frontend
```

### GET `/api/meta/status?client_id=CLIENT_ID`

Checks whether the client has an active Meta connection.

Returns connection status.

### GET `/api/meta/ad-accounts?client_id=CLIENT_ID`

Fetches ad accounts from Meta for that client's connection.

What happens:

```txt
1. Find active Meta connection
2. Check token is not expired
3. Call Meta /me/adaccounts
4. Return available accounts
```

### POST `/api/meta/select-account`

Stores which ad account should be used for a client.

Body example:

```json
{
  "client_id": "CLIENT_ID",
  "ad_account_id": "act_123456789",
  "ad_account_name": "Glow Skin Co Ad Account"
}
```

What happens:

```txt
1. Find active Meta connection for agency + client
2. Save ad account id and name
3. Return selected account
```

### GET `/api/meta/campaigns?client_id=CLIENT_ID`

Fetches campaigns from the selected Meta ad account.

Needs:

- Meta connected
- ad account selected

### GET `/api/meta/insights?client_id=CLIENT_ID`

Fetches Meta insights from the selected ad account.

This is a direct helper endpoint.

The operational report runner uses `metaInsights.service.js` for the scheduled/report flow.

## 12. Report Endpoints

Base:

```txt
/api/reports
```

### POST `/api/reports/create`

Protected.

Creates a report monitor.

Body example:

```json
{
  "formData": {
    "client_id": "CLIENT_ID",
    "name": "Weekly Executive Monitor",
    "type": "weekly",
    "status": "paused",
    "recipients": ["owner@example.com"],
    "monitored_campaigns": [
      {
        "campaign_id": "123",
        "campaign_name": "Prospecting"
      }
    ],
    "schedule": {
      "timezone": "Asia/Kolkata",
      "time_of_day": "09:00",
      "day_of_week": 1
    }
  }
}
```

What happens:

```txt
1. Read agencyId from token
2. Validate client_id and recipients
3. Normalize schedule
4. Create report
5. Record report_created activity
6. Return report
```

Important:

Creating a report does not automatically start it unless the status says active.

Usually you create it, then start it.

### POST `/api/reports/start-report`

Protected.

Starts a report.

Body example:

```json
{
  "reportId": "REPORT_ID"
}
```

What happens:

```txt
1. Find report inside current agency
2. Set status = active
3. Calculate next_run_at
4. Save report
5. Record report_started activity
6. Return report
```

### GET `/api/reports/get-reports`

Protected.

Gets reports for the current agency.

Optional query:

```txt
client_id=CLIENT_ID
```

### GET `/api/reports/:reportId`

Protected.

Gets one report inside the current agency.

### PATCH `/api/reports/update-report`

Protected.

Updates a report.

Body example:

```json
{
  "reportId": "REPORT_ID",
  "updates": {
    "name": "New Report Name",
    "status": "active",
    "type": "daily",
    "schedule": {
      "timezone": "Asia/Kolkata",
      "time_of_day": "10:30"
    }
  }
}
```

What happens:

```txt
1. Find report inside current agency
2. Update allowed fields
3. Normalize schedule
4. Recalculate next_run_at if active
5. Clear next_run_at if paused
6. If it changed from active to paused, record report_paused activity
7. Return report
```

### DELETE `/api/reports/delete-report`

Protected.

Deletes a report.

Body example:

```json
{
  "reportId": "REPORT_ID"
}
```

### DELETE `/api/reports/delete-report/:reportId`

Protected.

Same delete behavior, but report id is in the URL.

### GET `/api/reports/run-report?reportId=REPORT_ID`

Not protected right now.

This runs one report.

Optional:

```txt
force=true
```

What happens:

```txt
1. Calls reportRunner.runReport()
2. If report is skipped, returns skipped reason
3. If report runs, returns narrative, signals, comparison, email subject, email HTML
```

Why it is open:

This is probably meant for internal/n8n style usage.

Future TODO:

Add an internal secret header so random people cannot trigger reports.

### POST `/api/reports/manual-send`

Protected.

Runs a report immediately and sends the result to the manual-send n8n webhook.

Body example:

```json
{
  "reportId": "REPORT_ID"
}
```

What happens:

```txt
1. Calls generateMetaReport(reportId, force: true)
2. Builds report payload
3. Sends payload to n8n webhook
4. n8n handles the email/send flow
5. Returns reportData
```

### GET `/api/reports/run-all`

Not protected right now.

This is the endpoint n8n should call.

What happens:

```txt
1. Calls runDueReports()
2. Finds reports where:
   status = active
   next_run_at <= now
3. Runs due reports
4. Returns each report payload to n8n
```

This is how the due report system works.

The backend does not need to directly send every email itself.

n8n can call this and then send what is returned.

Future TODO:

Add an internal secret header.

## 13. Signal Endpoints

Base:

```txt
/api/signals
```

### GET `/api/signals`

Protected.

Gets signals for the current agency.

Optional query filters:

```txt
client_id=CLIENT_ID
report_id=REPORT_ID
severity=critical
limit=50
```

Default limit:

```txt
50
```

Max limit:

```txt
200
```

## 14. Activity Endpoints

Base:

```txt
/api/activities
```

### GET `/api/activities`

Protected.

Gets activity feed items for the current agency.

Optional query filters:

```txt
client_id=CLIENT_ID
report_id=REPORT_ID
type=signal_detected
severity=critical
limit=50
```

Default limit:

```txt
50
```

Max limit:

```txt
200
```

## 15. Task Endpoints

Base:

```txt
/api/tasks
```

This is older task/dashboard logic.

### POST `/api/tasks`

Protected.

Creates a task owned by the logged-in user.

### GET `/api/tasks`

Protected.

Gets tasks for the logged-in user.

### POST `/api/tasks/update-task`

Protected.

Updates a task.

### PATCH `/api/tasks/:taskId/subtasks/:subtaskId`

Currently not protected in the route file.

Future TODO:

Add `protect` here unless there is a very specific reason this should be public.

## 16. What Happens When A Scheduled Report Runs

This is the most important flow.

```txt
1. backend/src/jobs/n8nScheduler.js
   Every minute, it calls the n8n webhook.

2. n8n workflow
   Calls GET /api/reports/run-all.

3. runAll.controller.js
   Calls runDueReports().

4. reportRunner.service.js
   Finds active reports with next_run_at <= now.

5. For each due report:
   Load the Meta connection.

6. Check:
   Is Meta connected?
   Is token still valid?
   Is ad account selected?

7. timeWindowAggregator.service.js
   Builds current and previous windows.

8. metaInsights.service.js
   Fetches current period metrics from Meta.
   Fetches previous period metrics from Meta.

9. metricComparison.service.js
   Calculates percentage deltas.

10. performanceNarratorEngine.js
    Receives clean period metrics and deltas.
    Produces insight, recommendation, severity, and anomalies.

11. signalGenerator.service.js
    Converts narrator output into Signal documents.

12. activityRecorder.service.js
    Records:
    report_executed
    signal_detected
    decision_generated

13. reportRunner.service.js
    Updates the report:
    last_summary
    last_signal_at
    severity
    last_run_at
    next_run_at

14. performanceEmailFormatter.js
    Builds email subject and email HTML.

15. /api/reports/run-all returns payload.

16. n8n sends or processes the report.
```

## 17. What Happens When Manual Send Runs

```txt
1. Frontend calls POST /api/reports/manual-send
2. Backend checks auth
3. Backend calls generateMetaReport()
4. generateMetaReport() forces runReport()
5. Report is generated even if it is not due yet
6. Backend sends payload to manual-send n8n webhook
7. n8n sends the email
8. Backend returns reportData
```

Manual send is for:

- testing
- user pressing "send now"
- admin/debug workflows

Scheduled send is for:

- normal report automation

## 18. The Narrator Rule

This is very important for future development.

Do not put smart signal logic inside random controllers.

Do not make every report type have its own separate brain.

Good pattern:

```txt
Daily/weekly/monthly logic
  lives in timeWindowAggregator.service.js

Meta fetching
  lives in metaInsights.service.js

Metric comparison
  lives in metricComparison.service.js

Brain/intelligence
  lives in performanceNarratorEngine.js

Signal saving
  lives in signalGenerator.service.js

Activity saving
  lives in activityRecorder.service.js

Report orchestration
  lives in reportRunner.service.js
```

Bad pattern:

```txt
Controller directly fetches Meta,
calculates metrics,
creates recommendations,
saves signals,
and sends email.
```

That becomes messy fast.

## 19. Important Environment Variables

The backend expects these:

```txt
MONGO_URI
JWT_SECRET
CLIENT_ORIGIN
PORT
META_APP_ID
META_APP_SECRET
META_REDIRECT_URI
META_CLIENT_REDIRECT_URI
META_GRAPH_VERSION
NODE_ENV
```

Meaning:

- `MONGO_URI` connects to MongoDB.
- `JWT_SECRET` signs auth tokens.
- `CLIENT_ORIGIN` lets frontend send cookies to backend.
- `PORT` controls backend port.
- `META_APP_ID` and `META_APP_SECRET` are Meta OAuth credentials.
- `META_REDIRECT_URI` is where Meta sends the user after OAuth.
- `META_CLIENT_REDIRECT_URI` is where backend redirects frontend after Meta connection.
- `META_GRAPH_VERSION` controls Meta API version for insights.
- `NODE_ENV` controls cookie security settings.

## 20. Current Gotchas

### Gotcha 1: Open internal endpoints

These routes are not protected right now:

```txt
GET /api/reports/run-all
GET /api/reports/run-report
```

They are probably open so n8n can call them.

Better future version:

```txt
Require x-internal-secret header
```

### Gotcha 2: Task subtask toggle is not protected

This route is currently public:

```txt
PATCH /api/tasks/:taskId/subtasks/:subtaskId
```

It should probably use `protect`.

### Gotcha 3: n8n webhook URLs are hardcoded

Current n8n URLs live directly in code:

```txt
backend/src/jobs/n8nScheduler.js
backend/src/controllers/manualSend.controller.js
```

Better future version:

```txt
N8N_SCHEDULER_WEBHOOK_URL
N8N_MANUAL_SEND_WEBHOOK_URL
```

### Gotcha 4: Old task module is user-owned

The new architecture is agency-owned.

The task module still uses:

```txt
owner: req.user.id
```

That is old behavior.

It is okay for now, but do not copy that pattern into reports, signals, clients, or Meta connections.

### Gotcha 5: This is not GPT yet

The narrator engine is rule-based.

That is good for now because it is predictable.

Future GPT narrative generation should be added after this layer, not mixed into report running.

## 21. What I Changed In This Backend Phase

Plain version:

I moved the backend toward a real agency/workspace architecture and started building the operational engine around the existing narrator engine.

Detailed version:

```txt
1. Added/refactored agency-based models.
2. Made reports belong to agency + client.
3. Made Meta connections belong to agency + client.
4. Added signal storage.
5. Added activity storage.
6. Added client endpoints.
7. Added signal feed endpoint.
8. Added activity feed endpoint.
9. Refactored report runner so reports can actually execute.
10. Kept n8n in the system.
11. Made run-all use backend due-report logic.
12. Added metric comparison service.
13. Added time window aggregator.
14. Added Meta insights service.
15. Added signal generator from narrator output.
16. Added activity recorder.
17. Connected narrator engine to operational report flow.
18. Kept email formatting external to the narrator brain.
```

## 22. Where To Edit When You Want To Change Something

### Change report schedule rules

Edit:

```txt
backend/src/utils/reportSchedule.js
backend/src/services/timeWindowAggregator.service.js
```

### Change what Meta metrics are fetched

Edit:

```txt
backend/src/services/metaInsights.service.js
```

### Change how percentage changes are calculated

Edit:

```txt
backend/src/services/metricComparison.service.js
```

### Change signal intelligence

Usually edit:

```txt
backend/performanceNarratorEngine.js
```

Then translate output in:

```txt
backend/src/services/signalGenerator.service.js
```

### Change activity feed behavior

Edit:

```txt
backend/src/services/activityRecorder.service.js
backend/src/controllers/activities.controller.js
```

### Change report execution flow

Edit:

```txt
backend/src/services/reportRunner.service.js
```

### Change report API behavior

Edit:

```txt
backend/src/controllers/reports.controller.js
backend/src/routes/reports.routes.js
```

### Change Meta OAuth behavior

Edit:

```txt
backend/src/controllers/meta.controller.js
backend/src/routes/meta.routes.js
```

### Change email HTML

Edit:

```txt
backend/src/utils/performanceEmailFormatter.js
```

### Change n8n scheduling

Edit:

```txt
backend/src/jobs/n8nScheduler.js
```

## 23. Tiny Glossary

### Agency

The workspace.

### User

The person logged in.

### Client

A brand/account inside the agency.

### MetaConnection

The saved Meta access token and selected ad account for a client.

### Report

An operational monitor that runs on a schedule.

### Signal

An important thing the system detected.

### Activity

A timeline event.

### Narrator

The rule-based brain that explains what happened and what to do next.

### n8n

Automation tool that triggers workflows and sends report payloads/emails.

### Due report

A report where:

```txt
status = active
next_run_at <= now
```

## 24. Quick Test Checklist

Use this when testing the whole system.

### Auth

```txt
1. Register user.
2. Confirm agency is created.
3. Confirm user has agencyId.
4. Login.
5. Call /api/auth/me.
```

### Client

```txt
1. Create client.
2. Get clients.
3. Update client status.
```

### Meta

```txt
1. Call /api/meta/connect with client_id.
2. Complete Meta OAuth.
3. Check /api/meta/status.
4. Get ad accounts.
5. Select ad account.
6. Get campaigns.
```

### Report

```txt
1. Create report with client_id and recipients.
2. Start report.
3. Confirm next_run_at is set.
4. Manually call run-report with force=true.
5. Confirm narrative returns.
6. Confirm signals are saved.
7. Confirm activities are saved.
8. Confirm report last_summary and last_run_at update.
```

### n8n

```txt
1. Confirm backend started n8nScheduler.
2. Confirm n8n webhook receives the minute trigger.
3. Confirm n8n calls /api/reports/run-all.
4. Confirm run-all returns due reports.
5. Confirm n8n sends email using returned emailHtml.
```

## 25. The Most Important Rule To Remember

If you remember only one thing, remember this:

```txt
The report runner prepares the data.
The narrator engine understands the data.
The signal generator stores the result.
The activity recorder tells the timeline what happened.
n8n delivers the outside workflow.
```

That is the backbone of the backend.

