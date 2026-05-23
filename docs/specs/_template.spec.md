---
spec_id: <slug-here>
title: <one-line title>
status: draft  # draft | review | pilot | implement | verify | done
owner: <persona-id or agent_id>
created: 2026-MM-DD
updated: 2026-MM-DD
supersedes: []        # list of spec_ids this replaces, if any
superseded_by: null   # set when replaced; never delete a done spec
references:
  - <relative path to RFC or sibling spec>
acceptance:
  - given: <preconditions>
    when: <action>
    then: <observable result>
non_goals:
  - <explicit thing this spec is NOT trying to do>
---

# <Title>

## Summary
One paragraph. What does this spec achieve, and why now?

## Read first
Files an implementer must skim before writing code.

## Design

### Inputs
What state/files/messages does this consume?

### Outputs
What state/files/messages does this produce?

### Algorithm / contract
The core logic. For type contracts, paste the TS interface. For state
machines, draw the transitions. For protocols, show the message envelope.

## Acceptance criteria
Repeat the frontmatter `acceptance:` here, expanded with concrete
examples. Each `given/when/then` should be testable by a Verifier persona.

## Sequencing
| Step | Deliverable | Owner | Exit gate |
|---|---|---|---|

## Non-goals
What is intentionally out of scope. Cross-reference the spec that *will*
cover each non-goal.

## Open questions
What needs human or peer-agent input to close.

## Don't-do
Specific anti-patterns to avoid for this work — pull from
[cross-project survey §4](../research/2026-05-22-cross-project-survey.md)
or from a persona's `anti-patterns.md` when applicable.

---

> **Lifecycle.**
> - `draft → review` — the architect persona signs off on the spec.
> - `review → pilot` — a peer persona uses the spec to build one small
>   slice. The pilot proves the spec is actually buildable; if it's
>   painful here, fix the spec before broader work starts.
> - `pilot → implement` — the slice passes its Verifier.
> - `implement → verify` — the full feature lands.
> - `verify → done` — the security-auditor signs off (when applicable)
>   and tests pass.
>
> Status is updated **in place** — never delete a done spec; mark it
> `superseded_by:` if replaced.
