# Skill: Squad Lead Operations

## Purpose

Support Hardy's recurring responsibilities as Squad Lead with source-backed checks for capacity planning, billability and booking completeness.

## Control Areas

### Allocation planning

- Review every productive employee in Hardy's squad.
- Target at least 80% productive, billable project allocation.
- Plan 100% of available capacity. Use internal work or explicit Bench / Unallocated for the remainder.
- Complete the monthly plan by the first working day of the month.
- Review project-level allocations with the responsible Project Manager and Head Of when demand or capacity changes.
- Never interpret overplanning as an instruction to work above 80%; it is a resilience buffer for project changes.

### Weekly billability review

- Review current and expected billability for every squad member at least weekly.
- Flag every value below 80% and identify the responsible Project Manager or missing allocation decision.
- Distinguish a real capacity gap from a missing or stale planner entry.
- Discuss material allocation or planning changes with David Scharfschwerdt in the weekly meeting.
- Use the existing Google Task `Besprechung David` as the agenda source; do not create a duplicate task for the same planning topic.
- Treat statements from the latest Weekly or transcript about Mario's utilization or Panda's request for new projects as current squad planning signals.
- Replace the previous "Panda is fully booked" statement weekly with the latest dated source; never retain it as a permanent fact.

### Booking completeness

- Review the booking check weekly when time logs are available.
- Before the monthly booking and billing cycle, ensure no productive employee has a negative value in `Odoo - Hibob` / `Delta Odoo - Hibob`.
- Complete the month-end check by the first working day of the next month.
- Treat unresolved negative values as an escalation, not as a completed control.

## Briefing Output

Always include a `Squad Lead Control` subsection when relevant data is available:

- Allocation: employee, productive allocation, Bench / Unallocated portion and gap to 80%.
- Billability: current or expected value, deviation and responsible follow-up.
- Booking: employee, Odoo-Hibob delta and missing time-log period.
- Project planning: project, affected employee, stale or missing allocation and decision owner.
- David Weekly: planning changes to discuss with David Scharfschwerdt, linked to the existing weekly agenda task.
- Next control date and a concrete action only when the source supports it.
- Include all relevant project and capacity mentions from the source audit; mark material changes with `[ÄNDERUNG]` and link the exact source.

## Guardrails

- Do not invent employee allocations, billability, booking values, owners or deadlines.
- If Resource Planner or Booking Check data is unavailable, state the exact missing source and propose retrieving it through the connected browser session.
- Do not change Odoo, HiBob, Jira or Resource Planner records automatically.
- Google Tasks remain authoritative for task state; do not reopen completed tasks from an old planning document.
- A Bench / Unallocated entry is intentional capacity planning, not automatically a performance problem.
- Every finding must link to the source view or document.
