# Migration Known Issues — moved

This file now lives in **`decocms/migrations`**, as the skill
`knowledge/known-issues`, split into one reference per subject.

## Why it moved

It is migration knowledge, and this is the framework repo. The document's own
opening describes it as a checklist to walk against each newly migrated store
— that only makes sense when there is a "before" and an "after", which is the
line between what belongs here and what belongs there.

## Why it was split

It had reached 44.5KB in a single file. The generation before it — a
`gotchas.md` carrying 45 append-only numbered entries, to the point of
repeating its own numbering twice — is what that becomes if nobody stops it.
The 13 subjects it already had as sections are now 13 files, largest 5.9KB,
under a CI budget that fails past 15KB.

## Adding a new finding

Add it in `decocms/migrations`, to the reference for its subject. **Do not
re-create this file here.** Two copies of this knowledge already existed
across two repos and had drifted in opposite directions, each holding content
the other lacked; ending that is the entire point of the move.
