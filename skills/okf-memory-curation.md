# Skill: OKF Memory Curation

## Purpose

Create a durable, source-backed context from current Workspace evidence using OKF v0.2 concepts.

## Trigger

Run during the Daily process or when a material project, customer, squad or governance change is detected.

## Inputs

- Current Drive, Gmail, Calendar and Google Chat context
- Google Tasks with `[OFFEN]` and `[ERLEDIGT]` state
- Existing `agent-memory/` concepts

## Procedure

1. Keep only facts supported by current or explicitly authoritative sources.
2. Classify each concept into `projects/`, `customers/`, `squad/` or `general/`.
3. Add OKF frontmatter with `type`, `title`, `description`, `tags`, `status`, `generated`, `verified` and `sources`.
4. Preserve stable concept slugs and update existing concepts instead of creating duplicates.
5. Rebuild `index.md` and append a concise entry to `log.md`.
6. Synchronize the resulting bundle to Google Drive.

## Guardrails

- Never use an old source to reopen a completed Google Task.
- Never invent an owner, deadline, budget or project status.
- Do not store OAuth tokens, API keys or credentials in the bundle.
- Do not overwrite user-authored files outside agent-managed concept directories.
