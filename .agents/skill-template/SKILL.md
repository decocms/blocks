---
name: template
description: "Copy this folder to start a new skill. Replace this description with a specific one — it is the only thing an agent reads when deciding whether to load the skill, so say what it covers AND when to reach for it."
---

# <Skill name>

One paragraph: what this covers, and the situation you are in when you need it.
Write for someone who arrived here mid-migration with a broken page, not for
someone browsing.

## When to load what

`SKILL.md` is an index. Keep the body in `references/` and list it here, so an
agent loads one subject instead of everything.

| Reference | Load it when |
|---|---|
| [`references/<subject>.md`](./references/<subject>.md) | The symptom or decision that sends you there |

## <The actual short content, if any>

Small enough to live here? Keep it here. Past ~10KB this file fails CI, and the
fix is to move a subject into `references/`, not to trim prose.

## Rules for this skill

- One subject per reference file. No `gotchas.md`, no catch-all.
- Anything specific to one client goes in `clients/<slug>/`, never here.
- Say *why*, not just *what* — the reader can see the code; what they cannot
  see is the constraint that makes the obvious fix wrong.
