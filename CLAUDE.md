# Forge Project

This project is built with **Forge** — an autonomous spec-driven development loop.

## Methodology

- **Spec is truth.** All implementation derives from `specs/`. Read them first.
- **Code is ephemeral.** Code is wiped between cycles. Only the spec and learnings persist.
- **TDD.** Write tests before or alongside implementation. Tests prove spec compliance.
- **Lanes.** Work is decomposed into independent lanes (see `.forge/lanes.yaml`). Implement one lane at a time.
- **Adversarial review.** Every lane is reviewed against the spec. Violations trigger re-implementation.

## Key Paths

| Path | Purpose |
|------|---------|
| `specs/` | Source of truth — all requirements and constraints |
| `.forge/state.yaml` | Current cycle, phase, lane, and config |
| `.forge/lanes.yaml` | Lane decomposition for current cycle |
| `.forge/checkboxes.md` | Work items extracted from spec checkboxes |
| `.forge/learnings/` | Accumulated insights from previous cycles |
| `.forge/escalation.md` | Unresolved review failures |

## Rules

1. Never contradict the spec. If spec and code disagree, the spec wins.
2. Read `.forge/learnings/` before implementing — previous cycles discovered constraints.
3. Commit after each meaningful unit of work with `[FORGE]` prefix.
4. Update `.forge/checkboxes.md` status as work items are completed.
5. Keep implementations minimal — solve what the spec asks, nothing more.
