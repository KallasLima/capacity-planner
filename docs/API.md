# Capacity API and behavior reference

The capacity view includes week navigation, date-range selection, roster search and
pagination, overload prioritization, inline weekly-capacity editing, project breakdowns,
and a capacity scenario planner. Search and overload prioritization work across the
matching roster. Capacity changes apply to every week for that person.
The initial six-week view runs from December 29, 2025 through February 8, 2026.
Range presets cover 3, 6, or 12 weeks; the mobile view keeps one selected week readable.

## Reading capacity

`GET /api/capacity?from=2025-12-29&to=2026-01-16&offset=0&limit=50` returns normalized
`from`/`to` dates, `weeks` with `start`/`end`, and `people` with `id`, `name`,
`weeklyHours`, and an aligned `allocatedHours` array. `total`, `offset`, and `limit`
describe the roster page. People with no assignments remain visible. The maximum range
is 106 weeks and the maximum page is 100 people; the UI requests 50 at a time.

Add `search=Dee` to filter names using a case-insensitive substring. Search is trimmed,
accepts up to 100 Unicode characters, and treats `%`, `_`, and `\` as literal characters.
Filtering happens before pagination, and `total` reports the matching roster count.

Add `status=all|over` (default `all`) to include everyone or only people whose
allocation exceeds capacity in at least one selected week. Add `sort=name|overload`
(default `name`) to sort by name or highest single-week overload, descending. Ties
use name and ID for stable pagination. Both controls reset the UI to the first page.
The response's `summary` covers the entire eligible roster after search and status
filtering, across every selected week:

```json
{
  "people": 120,
  "overCapacityPeople": 17,
  "allocatedHours": 12345,
  "availableHours": 6789
}
```

`availableHours` sums positive remaining capacity per person-week, so one person's
overload does not cancel another person's available hours. The summary is separate
from the visible page's overload count. Saving while a priority filter or sort is
active refreshes the page so membership and ordering remain correct.

## Updating weekly capacity

`PATCH /api/people/{id}` requires both values:

```json
{
  "weeklyHours": 32,
  "expectedWeeklyHours": 40
}
```

The update atomically checks that stored capacity still equals `expectedWeeklyHours`,
then returns the canonical `id`, `name`, and `weeklyHours`. Both values must be 0–168
hours with at most two decimal places. If the capacity changed, HTTP 409 returns
`{"error":"...","person":{"id":4,"name":"Dee Okafor","weeklyHours":50}}`.
The editor retains the draft, shows the latest value, and requires an explicit
**Save my draft** action to apply it against that value. A retry whose requested value
is already stored returns 200, allowing confirmation after a lost response.

Invalid input returns 400, a missing person returns 404, and oversized bodies return 413. Allocation sums all overlapping assignment records on weekdays, including
distinct records with identical values. See [DECISIONS.md](../DECISIONS.md) for the choices.

## Capacity scenarios

Choose **Plan capacity**, edit recurring weekly limits, and **Stage change**. Staging
updates the preview and local backup; it sends no capacity write request. The scenario shows
before/after limits and overloaded person-weeks for the planned people in the selected
range. Restaging retains each person's original expected value. Returning to that
value removes the no-op change. Plans hold up to 100 people, can span roster pages,
and preserve the current search, status, sort, and page when planning begins.
Search, priority controls, and pagination remain available. They use saved capacities;
draft limits change preview rows and impact, not roster membership or ranking.
Dates, presets, and reset stay locked to keep the plan's allocation horizon stable.
Leaving with drafts prompts a browser warning.

Project details remain available during planning. The drawer labels the saved weekly
capacity separately from a staged limit, including a draft of zero hours. Its project
allocations remain saved data.

**Apply plan** sends one atomic request:

```http
PATCH /api/people/capacities
Content-Type: application/json

{"changes":[{"id":4,"weeklyHours":50,"expectedWeeklyHours":40},{"id":5,"weeklyHours":24,"expectedWeeklyHours":0}]}
```

The API accepts 1–100 unique, positive person IDs, with the same 0–168 hour and
two-decimal rules as individual edits. It locks affected rows in ID order and checks
every expected value before writing. Success returns `{"people":[...]}` with canonical
values for every requested person. A missing person returns 404 with no changes.
A conflict returns 409 with `error` and canonical `people` for all requested IDs;
that attempt changes nothing. The UI preserves proposed values, updates their
starting values, and requires **Apply reviewed plan**. Values already at the proposal
drop out of the remaining draft.

An identical retry succeeds when the proposed values are already stored, which
confirms a write whose response was lost. After an unconfirmed apply, the UI freezes
staging and removal, retains the draft and warning, and offers retry or **Close and
refresh**. **Discard plan** also refreshes saved values. Applying, discarding, or
removing changes is disabled while an inline editor is open.

### Browser-local recovery

Draft backups use versioned, validated records in local storage and expire 24 hours
after their last save. They include the plan's range, search, filters, order, page,
proposals, expected capacities, and unresolved-apply state. They belong to this browser
and site; there is no server-side draft store or cross-browser collaboration.

After refresh or reopening, choose **Restore draft** or **Discard saved draft**.
Restoring first reads each person's current capacity through the existing allocation
endpoint, then restores the query context. This read-only step sends no PATCH. Ordinary
drafts use the latest starting values, remove proposals already saved, and require
**Apply reviewed plan** when baselines changed. The fixed assignment input lets the
stored allocation arrays continue to describe the selected horizon.

Before sending an apply, its backup is marked uncertain. If the tab closes or the
response is lost, restoration preserves the original proposals and expected values
unchanged for an identical retry; staging and removal stay frozen until the outcome
is resolved. Confirming or discarding a plan closes that plan's recovery path.

Records have separate plan IDs. Restoring forks a new record and consumes the source
revision without deleting another open tab's backup. Expired or malformed records
are rejected. If storage is unavailable, a visible warning explains that the open
plan remains usable but recovery cannot be relied on.

## Allocation breakdown

Click a team member's name to open their project breakdown, then move between weeks
inside the drawer. `GET /api/people/4/allocations?week=2026-01-05` returns `person`,
a normalized Monday–Sunday `week`, total `allocatedHours`, and `projects` with `id`,
`name`, `hours`, and `assignmentCount`. This read-only view uses the same weekday and
additive-row rules as the grid. Invalid IDs or dates return 400; a missing person returns 404.

For Dee in the week of January 5, the total is 45 hours: Atlas contributes 30 hours
from 15 assignment rows, and Corvus contributes 15 hours from 15 rows. Compare that sum
with the grid, then change weeks and close the drawer to return to the same person.

## Checks

With the application running through `make up`, run:

```bash
docker compose exec -T api go test -v ./...
docker compose exec -T web npm test
docker compose exec -T web npm run build
```

The Go query and mutation tests use temporary PostgreSQL tables inside rolled-back
transactions and preserve the seeded roster. Frontend tests exercise the editor and
scenario state transitions. Coverage includes roster-wide summary and priority
semantics, atomic batch conflicts and retries, draft preservation, and obsolete
responses.

The current priority query was also checked against independently calculated seed
arithmetic: 75,585 cells across 500 people, plus 31,314 cells in an isolated synthetic
fixture of 3,000 people and 757,170 assignments. Whole-roster summaries, overload
filtering, ordering, search, and first/last pages matched. In that isolated local
fixture, sampled 105-week requests took 1.28–1.30 seconds. These sequential local
observations use repeated seed patterns; concurrent production workloads remain
unmeasured. The browser also rendered 50 people across 105 weeks without page overflow.

To inspect the grid's numbers, use the week of
January 5, 2026: Bo is 32/40 hours, Cem 4/20, Dee 45/40, and Eli 20/0. Edit a capacity,
check every displayed week, then reload to verify persistence. A failed save should
retain the typed value and allow retry.

To check a conflict, open the same person's editor in two browser tabs before saving
either. Save a change in the first, then submit a different draft from the second.
The second tab should show the
new server value without overwriting it and retain its draft for **Save my draft**
or Cancel.

Cancel or Escape after an unsuccessful save reloads current server values, including
when the write committed but its response was lost. If reconciliation fails, the grid
is replaced by a retry state. Keyboard focus returns to the edited person after recovery.

To inspect a scenario, stage a higher limit for Dee and another person's change.
The grid should preview both without changing saved values in a second tab. Apply
once, then reload the second tab to check persistence. If one starting value changes
in the other tab before applying, the entire batch should conflict without partially
applying the other change.

To inspect recovery, stage a proposal and refresh, then choose **Restore draft**.
The original range and filters return after current capacities are checked. Change
the baseline in another tab before restoring to exercise explicit review. A failed
recovery keeps the saved draft available to retry or discard.

Vite is patched to 8.2.4. The original Compose, Dockerfile, Makefile, schema, and seed
are unchanged. For local-only access, use a separate uncommitted Compose override that
replaces published ports with loopback bindings. No authentication is included in this
local assignment scaffold.
