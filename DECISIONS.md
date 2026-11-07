# Decisions

## What did the spec not tell you?

- Weeks start on Monday; selected dates include complete weeks. Assignments count
  weekdays, inclusively, without holidays. The fixed schema stores one recurring
  capacity per person, so changing it affects past and future weeks.
- Search, overload priority, and summaries cover the matching roster before
  pagination. The browser displays 50 people at a time across bounded dates;
  pagination limits rendering without making priority depend on the visible page.
- Saves compare the opened value with current capacity. Conflicts retain the draft
  for explicit review. Confirmed values update every week; failed or uncertain saves
  preserve intent and reconcile with the server. Obsolete responses are ignored.
- The optional scenario previews recurring limits, not assignment redistribution.
  Atomic apply avoids partially saving a plan when one starting value conflicts.
  Filters and ordering use saved capacities during planning so proposed limits do
  not move people out of the manager's working context. Project details distinguish
  saved and draft limits; dates stay fixed to keep impact comparisons coherent.
- Browser-local draft backups expire 24 hours after their last save. Restoring is
  explicit and checks current capacities before apply; changed baselines require
  review. An uncertain apply keeps its original payload for a safe retry. Per-plan
  records isolate tabs; storage failures warn while leaving the open plan usable.

## What did you notice that looked wrong?

- Fractional daily values and equal-looking assignments with distinct IDs require
  summing every supplied row. For January 5, Dee is 45/40 h and Eli is 20/0 h.
  Both are overloads; zero capacity is handled without division by zero.

## What did the AI get wrong that you caught?

- The initial flow treated a failed response as an unchanged server. A write can
  commit before its response is lost, so Cancel left stale numbers. Cancel/Escape
  now reconcile with the server. Real dropped-response checks and regressions also
  caught an uncertain scenario's removable draft erasing its safe-retry intent;
  draft editing now stays frozen until the outcome is resolved.

## What would you do differently with a week?

- Extend recurring-limit scenarios into collaborative branches that compare
  staffing alternatives, delivery risk, and cost, then publish an agreed plan with
  an audit trail and undo.
- Model effective-dated capacity, PTO, holidays, and working schedules. Use them for
  explainable allocation-rebalancing recommendations constrained by skills,
  priorities, deadlines, and availability, with reviewable tradeoffs before applying.
