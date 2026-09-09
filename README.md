# ADO DEC Dashboard

A real-time delivery health and roadmap visualization dashboard for Azure DevOps Features, built to surface Readiness gaps, Delivery Health risks, and Release/Sprint alignment issues across the Commercial Engineering portfolio.

## Table of Contents

Quick Start

Architecture Overview

Configuration

Functionality Documentation

Feature List

Roadmap View

Delivery Health Engine

Release / Sprint Alignment

Readiness Validation

Advanced Filtering

Caching & Background Sync

API Reference

Authentication (Enterprise SSO)

Troubleshooting


# Quick Start


## Prerequisites

	• Node.js 18+ and npm
	• Access to an Azure DevOps organization with a Personal Access Token (PAT) scoped to Work Items (Read)
	• An Upstash Redis instance (or compatible Redis REST API) for caching
	• A Vercel account (recommended deployment target; the app auto-configures Cron Jobs via vercel.json)
	• (Optional, enterprise) Access to register an app in your organization's Azure Active Directory tenant


## Installation

	1. Clone the repository: 

   		git clone <repo-url>
   		cd ado-dec-dashboard
	
	2. Install dependencies:

  		npm install

	3. Create a .env file in the project root:

		*Azure DevOps (required)*
		ADO_ORG=your-org-name
		ADO_PROJECT=your-project-name
		ADO_PAT=your-personal-access-token
		
		*Redis (Upstash)*
		KV_REST_API_URL=https://your-instance.upstash.io
		KV_REST_API_TOKEN=your-upstash-token
		
		*Internal sync endpoint protection*
		CRON_SECRET=a-long-random-string
		
		*Optional*
		DASHBOARD_TIME_ZONE=America/Chicago
		CACHE_AUDIT_WATCH_FEATURE_IDS=1290868
	
	4. Verify your business rule configuration files exist:

  		/config/delivery-health-rules.json
  		/config/release-calendar.json
  
		>⚠️ The application will not start if these files are missing or fail schema validation — this is 
		intentional, to prevent running Delivery Health calculations against an incomplete policy.

	5. Start the application:

		npm start
  
	6. Navigate to:

		http://localhost:3000/dashboard-app
		

## First-Time Setup Guide

	1. On first load, the dashboard fetches Features changed in the last 10 days live from Azure DevOps — no manual 
	seeding required.
 
	2. Historical Features (10–730 days) are populated by the nightly Cron job hitting /api/internal/sync-feature-caches. 
	Locally, trigger this manually: 
 
  		curl -H "Authorization: Bearer $CRON_SECRET" \
  		http://localhost:3000/api/internal/sync-feature-caches
  
	3. Configure your default filter view via the Advanced Filters panel, then click Save as My filter to persist it for future sessions.


## Common Troubleshooting

**Issue:** App fails to start with Missing required environment variable|

**Likely Cause:** .env incomplete

**Fix:** Confirm ADO_ORG, ADO_PROJECT, ADO_PAT, CRON_SECRET are all set



**Issue:** Unable to load config/delivery-health-rules.json

**Likely Cause:** File missing/invalid JSON

**Fix:** Validate JSON syntax; confirm file is deployed alongside server.js



**Issue:** Dashboard shows "Historical Features could not be fully retrieved" (503)

**Likely Cause:** Redis cache empty and Cron hasn't run yet

**Fix:** Manually trigger /api/internal/sync-feature-caches with a valid CRON_SECRET



**Issue:** Features show "Unable to evaluate" Delivery Health

**Likely Cause:** ADO batch request failures (throttling/network)

**Fix:** Check server logs for 429/5xx from Azure DevOps; retries are automatic via withAdoRetry



**Issue:** Target Dates appear off by one day

**Likely Cause:** Timezone mismatch

**Fix:** Confirm DASHBOARD_TIME_ZONE matches release-calendar.json's timeZone field — the app validates this at startup and will refuse to start otherwise



# Architecture Overview

* Backend: Express.js server proxying Azure DevOps REST API (workitemsbatch, wiql, revisions) with retry/backoff logic (withAdoRetry) and concurrency-limited batch fetching.
* Cache layer: Upstash Redis stores incremental historical Feature shards (5 rolling date ranges), Feature/Story Aging data, and a persistent Cron sync audit trail.
* Frontend: Single-file React app (via Babel Standalone, no build step) rendering Feature List and Roadmap (Gantt) views.
* Scheduling: Vercel Cron triggers /api/internal/sync-feature-caches nightly to refresh historical caches without impacting live user requests.


### Configuration


**Delivery Health Rules (config/delivery-health-rules.json)**
Defines the business logic for classifying Feature delivery risk. Key sections:

* workItemStates: Maps Azure DevOps states to delivery categories (inPlanning, inProgress, toRelease, completed, removed).
* featureStates: Maps Feature-level states to lifecycle stages (execution, closed, notStarted).
* thresholds:
  * targetDateNearDays (default 14) — window for the "Target date near" alert.
  * toReleaseMaxDays (default 45) — max allowed days a work item can sit in "To Release" before flagging as aged.
* rules: Each rule (e.g., overdue, releaseCommitmentMissed) defines enabled, group (requires-action / requires-attention / healthy / not-started), label, reason/reasonTemplate, and recommendedAction.

> Editing this file requires restarting the server — it is validated and loaded once at boot via validateDeliveryHealthRules().



**Release Calendar (config/release-calendar.json)**

Defines the RFV (Release Fix Version) publishing calendar and Sprint-to-release mapping used for Release/Sprint Alignment calculations:

* releases[]: Each entry has rfv, date (YYYY-MM-DD), sequence (used for ordering comparisons), and status (published/provisional).
* sprints[]: Each entry has id, startDate, endDate, optional commitmentCutoffDate (defaults to startDate), and deliveryRfv (which release this Sprint delivers into).

> TimeZone in this file must match DASHBOARD_TIME_ZONE exactly — the app throws a startup error otherwise, to guarantee consistent "day of business" calculations across Overdue, Target Date, and Release Alignment rules.



# Functionality Documentation


### Feature List

Overview: Tabular view of all Features in scope, with sortable columns for Priority, Target Date, Release Fix Version, Estimates, State, Readiness, Delivery Health, and Progress.

Usage:

Navigate to Feature List from the top navigation switcher.
Click any column header to sort (click again to reverse order).
Click a row (or its disclosure arrow) to expand and view:
Feature Readiness status and missing/unknown checks
Delivery Health alerts with recommended actions
Release Alignment status and metrics
Full Stories and Bugs breakdown, filterable by delivery stage or execution team


### Roadmap View

Overview: Gantt-style timeline visualization plotting Feature state history, Target Dates, Release Fix Version markers, and Tech Go-Live markers across a scrollable time axis.

Usage:

Switch to Roadmap from the navigation.
Use the Months/Weeks toggle to change timeline granularity.
Drag horizontally on the timeline to pan, use arrow keys to move one unit at a time, or press Home to snap back to Today.
Click a Feature row to expand and reveal individual Story/Bug timelines beneath it.

**Legend:**

*Marker	Meaning*
Blue vertical line  	Today
Red triangle	        Target Date
Blue diamond	        Release Fix Version date
Gold star	           Tech Go-Live RFV date


### Delivery Health Engine
Overview: A rules-driven classification system (configured entirely in delivery-health-rules.json) that evaluates each Feature against 14+ conditions — Overdue, Needs Estimate, Release Commitment Missed, To Release Aging, etc. — and surfaces the highest-priority alert plus all accumulated alerts.


**Categories (mutually exclusive at the KPI level):**

🔴 Requires Action — Overdue, release commitments missed, dates passed with open work

🟠 Requires Attention — Needs estimate, no Stories, pending release, aging in To Release

🔵 Not Started — New Features with no associated work yet

🟢 Healthy — No risks detected

Usage: Click any KPI card at the top of the dashboard to filter the Feature List/Roadmap to that exact category.


### Release / Sprint Alignment

Overview: Validates whether a Feature's pending Stories/Bugs are assigned to Sprints and Release Fix Versions compatible with the Feature's own committed RFV, using the release-calendar.json Sprint-cutoff logic.

Statuses: Aligned · At Risk · Commitment Missed · Release Date Passed · Unavailable · Not Applicable

Usage: Expand any Feature row and review the Release Alignment panel for affected work item counts, cutoff dates, and the suggested next viable RFV.


### Readiness Validation

Overview: Confirms each Feature has the minimum required fields before entering delivery: Description, Acceptance Criteria, Customer Benefit, Parent link,
