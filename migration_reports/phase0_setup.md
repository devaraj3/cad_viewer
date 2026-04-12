# Phase 0 - Safety and Workspace Setup

## Scope Guardrails
- Personal target repo: `/Users/devaraj/Downloads/My Projects/cad_viewer`
- Company source repo (read-only for this migration): `/Users/devaraj/Downloads/projects/ffp`
- Branch created in personal repo: `migration/cad-company-port`

## Safety Approach
- Migration work is confined to the personal repo.
- Company repo is used only as source reference for CAD files and architecture.
- No destructive history rewrites are used.
- Checkpoint commits are created before and after major migration stages.

## Baseline Status Before Structural Changes
- Baseline build and typecheck will be executed before CAD module cutover.
- This file marks the pre-restructure checkpoint required by the migration process.
