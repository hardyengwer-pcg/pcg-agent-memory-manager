# Skill: Task State Reconciliation

## Purpose

Keep recommendations aligned with the authoritative Google Tasks state.

## Procedure

1. Fetch open and recently completed Google Tasks.
2. Mark open tasks as active even when older notes call the project complete.
3. Treat completed tasks as final and suppress matching recommendations everywhere, including project status text.
4. Match title variants by meaning, not by exact spelling only.
5. Create a new Task only when no equivalent open or completed Task exists.

## Guardrails

- Do not reactivate `[ERLEDIGT]` items from Drive, Mail, Chat or Calendar.
- Do not close a project merely because one task is completed.
- Do not create duplicate tasks from repeated meeting notes.
