# Architecture Decision Records

Archstone records every structural decision as an ADR before merge — context, alternatives
considered, consequences. This directory holds the subset that constitutes **commitments to the
people who use Archstone**: what stays free, what is never for sale, and what an agent is never
given.

They are published so that a business writing a CDL manifest can read the reasoning behind those
commitments rather than only the sentence in the README — including the alternatives that were
considered and refused, which is the part that distinguishes a decision from a slogan.

## Index

| ADR | Title | Status |
|---|---|---|
| [0005](0005-open-core-boundary-artifact-guarantee.md) | The open-core boundary is an artifact guarantee, not a feature list | ✅ Accepted |
| [0006](0006-marketplace-neutrality.md) | Selection is never for sale | ✅ Accepted |
| [0008](0008-undeclared-provider-data-never-reaches-a-model.md) | Undeclared provider data never reaches a model | ✅ Accepted |
| [0011](0011-undeclared-model-output-never-reaches-a-business-system.md) | Undeclared model output never reaches a business system | ✅ Accepted |
| [0021](0021-html-is-passed-through-unmodified-or-withheld-whole.md) | Provider HTML is passed through unmodified or withheld whole | ✅ Accepted |

## What a published ADR is

A **public edition** of a ratified record: the decision, its reasoning, its rejected alternatives
and its consequences, reproduced as accepted. References to internal planning and architecture
documents are removed or summarised in place, because a citation a reader cannot follow is worse
than no citation. Nothing in a decision itself is abridged — where an ADR states a commitment,
that commitment is the one in force.

## Why the numbering has gaps

ADR numbers are assigned in one sequence across the whole project, and most decisions are
engineering ones — repository layout, language triage, versioning policy — rather than promises to
users. Those are not published here. Where a specification, source comment or changelog entry
cites an ADR by number, the number is stable and names the same decision whether or not its record
appears in this directory.

## Reversal

An accepted ADR is reversed only by a superseding ADR. For the commitments in this directory the
sequence is stricter, and each record states it: supersede the ADR, change the public statement,
and only then act on the change. Never a product change that quietly makes an existing promise
false.
