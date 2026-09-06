---
project: Métis
type: locked-mode-skills-contract
owns: shipped operator skills for the nine builtin conversation modes, plus the shared humanizer and Ask caveman
does-not-own: overlay chrome (Bar / Island / Hide), Overlay 58, Brain 69, user-editable mode prompts
ready-to-merge: no until Devon Mac-shows Interview + Cold Calling + Support answers that use the skill, and Settings cannot edit it
---

# Locked mode skills

Tony's rule: the visible prompt in Settings → Personalize stays user-editable. The thing that actually makes the LLM sharp is a **shipped skill** that runs in the background. Nobody can change that skill unless Tony ships a Métis release of that specific file.

This file is the contract. Implement only what it names.

## What ships

Nine builtin modes (`CONVERSATION_MODES` in `src/shared/ipc.ts`):

| id | label | Skill job |
| --- | --- | --- |
| `interview` | Interview | Candidate copilot. Best answers. STAR / CAR unlabeled. I, not we. First sentence answers the real question. |
| `recruiting` | Recruiting | Interviewer. Drive Tony's Amaris / Mantu interview sheet through conversation. One open question at a time. |
| `meeting` | Meeting | Live copilot. Next 15 to 40 seconds, or the one question that unblocks the room. |
| `sales` | Sales | Live seller. Discovery before talking. One move. Next step. |
| `negotiation` | Negotiation | Live deal. One move. Never concede for free. |
| `presentation` | Presentation | Live presenter. Land the point. Recover a blank. |
| `support` | Support | Human, calm, specific. One empathy clause, then the fix. |
| `general` | General | Always-on. Sharpest person in the room. Next line or one best question. |
| `cold-call` | Cold Calling | Live caller. 70 / 30 listen. One discovery question or one spoken line. Not a prep memo. |

Plus two shared skills:

| id | path | Job |
| --- | --- | --- |
| `humanizer` | `skills/humanizer/SKILL.md` | Spoken lines a colleague would actually say. Embedded in every mode skill. Also composed after every ask. |
| `caveman` | `skills/caveman/SKILL.md` | Ask answer register. Default **full**. Off via "stop caveman" / "normal mode". Auto-Clarity drops it for warnings. Not a tenth conversation mode. Not Operator pack push. |

Files:

```
skills/humanizer/SKILL.md
skills/caveman/SKILL.md
skills/modes/<id>/SKILL.md
```

Each file starts with a YAML header:

```
---
id: interview
version: 1.1.0
locked: true
---
```

`version` is per-skill. Bumping a skill is a Métis release of **that file's hash**. Other skills stay put.

Do **not** paste third-party `SKILL.md` files into this repo except Ask `caveman`, which is the JuliusBrussee/caveman playbook locked into the existing mode-skills contract (header + Ask register wiring). Patterns below were analyzed; other wording is ours.

## Sources analyzed (patterns, not text)

Cited here only. None of these files are copied into `skills/`.

- [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins) (sales / call-prep, customer-support, product-management). Discovery before talking. Meeting-type variations. Objections as a table you use live, not a memo. Agenda and a concrete next step. Skills fire in the background; slash commands are the explicit path. Métis analog: locked skill injects after the user prompt; Settings never edits it.
- [yanliudesign/behavior-question-skill](https://github.com/yanliudesign/behavior-question-skill). Mine real stories from the transcript and profile. STAR / CAR without dumping the labels out loud. One question at a time. JD-driven shortlist. Never canned answers.
- [noamseg/interview-coach-skill](https://github.com/noamseg/interview-coach-skill) and Melodic Software interview-coach. Interviewer inner monologue. Two or three follow-ups. Probe for specifics (number, owner, trade-off).
- [conorbronsdon/avoid-ai-writing](https://github.com/conorbronsdon/avoid-ai-writing) and [hannsxpeter/humanizer](https://github.com/hannsxpeter/humanizer). Em dashes out. No Certainly / Great question / I hope this helps. No delve, leverage, robust, seamless, game-changer. No "It's not X, it's Y". Contractions. Mix short and long. Spoken register. Never invent first-person experience the transcript does not support.

## Recruiting spine (Tony's interview sheet)

`recruiting` is the interviewer. `interview` is the candidate. Do not mix them.

Tony's Amaris / Mantu interview sheet is the **recruiting** skill's backbone. Drive the sheet through conversation. Track which cells are already filled from the live transcript. The next question is the highest-value **empty** cell. Do not read the form out loud. Never yes / no. After they answer, one precise follow-up, then score silently.

Sheet cells the skill must cover over a live interview (not in one dump):

- **Track.** Corporate vs Consulting. Cooptation. Number of applications.
- **Identity.** Name, phone, graduation year, school, speciality, habilitation.
- **Wishes.** Expectations. Sector. Reasons to leave. Motivations / drivers. Professional experience / sector / skills they want to use.
- **Job research.** Companies, jobs, process status, deadline. Criteria of selection.
- **Mobility.** Western / Eastern / Central Europe, North / South / Central America, Middle East, Asia Pacific, Oceania. City. Contract type.
- **Comp (current).** Yearly gross, monthly gross, monthly net, variable, bonus, profit sharing, representation fee, holidays, lunch voucher, laptop, cellphone, car / public transport, health insurance, group insurance.
- **Admin.** Nationality, work permit, driving license, date of birth, family situation, partner job / salary, owner / accommodation.
- **Languages.** FR, UK, ES, CAT, IT, GER, PO, CN, NL, plus others with a level.
- **Score.** A / B / C / D on Technical, Functional, Personality, Dynamism and Motivation. Potential manager yes / no plus comments. Evidence from this conversation only.
- **Projects portfolio.** For each client: duration, 2 to 3 line context and objectives, personal responsibilities (not the team's), environment keywords.
- **Close cells.** Salary expectations. Availability theoretical vs real. Ready to leave tomorrow for the dreamed project?

Open-question bar (write better than these, never yes / no):

- "What would make the next role a no-brainer?"
- "Walk me through a project you owned end to end. What broke?"
- "If you left tomorrow, what are you walking toward, not away from?"

Kill-the-process empty cells outrank nice-to-have color: work permit, real availability, salary expectations, dreamed-project readiness, then a flagship project's personal ownership.

## Mode split (exact)

- `recruiting`: YOU = interviewer. THEM = candidate. Best open-ended question. Short.
- `interview`: YOU = candidate. THEM = interviewer. Best answer. STAR unlabeled. I, not we. First sentence answers the real question.
- `cold-call`: live caller. 70 / 30 listen. One discovery question or one spoken line. Not a prep memo.
- `sales` / `negotiation` / `presentation` / `support` / `meeting` / `general`: live copilot. Next 15 to 40 seconds of speech, **or** the one best question. Never a dump.

## Lock

At authoring / CI:

1. `scripts/lock-mode-skills.mjs` SHA-256s every skill file (UTF-8 bytes, LF only, as committed).
2. It writes `src/shared/mode-skills.lock.json` (schemaVersion 1, algorithm `sha256`, path + version + sha256 per id).
3. `node scripts/lock-mode-skills.mjs --check` fails if a file drifted from the lock.

The lock is compiled into the signed app. Updating a skill without updating the lock is a failed build. Updating the lock without a file change is a failed build.

At load / ask time:

1. Main reads the file from the skills root (repo checkout in dev, `process.resourcesPath/skills` when packaged).
2. Re-hashes. Compares to the lock.
3. Header `id`, `version`, and `locked: true` must match the lock.
4. **Mismatch, missing file, or unlocked header: refuse the skill and fail loud.** Do not inject a modified body. Do not skip the skill and keep answering. The ask errors with a sentence that names the skill and says to reinstall this Métis build or wait for a Métis update of that skill.

A user, Settings, `modePrompts`, `systemPrompt`, or a custom mode cannot replace, delete, or override a builtin skill body.

## Composition (ask time)

`buildSystem` still resolves the **visible** prompt the old way:

`settings.modePrompts[mode]` if set, else `DEFAULT_MODE_PROMPTS[mode]`.

Then main appends locked skills **after** that user / default prompt:

```
[user systemPrompt prefix]
[visible mode prompt]
[LOCKED MODE SKILL]     ← builtin modes only, exactly one
[LOCKED HUMANIZER]      ← always, including custom modes
[LOCKED CAVEMAN]        ← typed Ask (answer/vision) only, default full, omitted when off
[profile / docs / rails / language]
```

Rules:

- Builtin mode: exactly one locked mode skill + the humanizer.
- Custom user mode: humanizer only. Never a fake builtin skill. Never "closest match".
- Typed Ask (`answer` / `vision`, not fact-check): also locked caveman at `settings.askCaveman` (default `full`). `/caveman lite|full|ultra|wenyan-*` and "stop caveman" / "normal mode" persist in that same settings field and strip from the visible question. Auto-Clarity drops caveman for security warnings, irreversible confirms, multi-step fragment risk, compression ambiguity, and "clarify".
- Fact-check: no mode skill, no humanizer, no caveman (VERDICT contract stays clean, same as today's persona skip).
- Recap / summary / live suggest: no caveman. Those paths keep their own prompts and `HUMAN_STYLE`.
- Typed / screen asks still `retargetForTypedAsk` on the **visible** prompt only. The skill playbook stays. The spoken OUTPUT FORMAT in the visible prompt is what gets swapped.

Each mode skill embeds a Humanizer section so the playbook is complete if read alone. The shared `humanizer` file is still composed in. That is not a user toggle.

## Settings

Settings → Personalize still edits the visible prompt and context files.

Settings has **no editor** for skill files. No textarea, no reset, no import, no delete, no override of `skills/modes/**` or `skills/humanizer/**`.

Builtin modes may show a read-only line: the skill is locked to this Métis build, with the shipped version. That line is not an editor.

## Quality bar

Write each skill as a world-class operator playbook. Not adjective soup. Concrete moves, what to listen for, what to say, what never to do.

Output format stays compatible with the existing first-person spoken line plus an optional `Backup:` line, unless the mode already differs (recruiting is a short question). Never write `Backup: none`.

Humanizer (spoken and written the user will say out loud or send):

- Sounds like a colleague in the room.
- No AI cadence. No "I'd be happy to". No em dashes. No "as an AI".
- No Certainly / Great question / I hope this helps.
- No delve, leverage, robust, seamless, game-changer.
- No "It's not X, it's Y".
- Never identify as AI, a model, or Métis in external content.
- Contractions. Mix short and long. Specific. Their words.
- Never invent first-person experience the transcript or profile does not support.

## Do not

- Restyle Bar, Island, or Hide. Overlay 58 stays frozen.
- Pack an installer for this slice.
- Merge leftover Brain 69.
- Let a hash mismatch fail closed into a skill-less answer.
- Invent a tenth builtin mode to hang a skill on.
- Paste third-party skill files.

## Tests (load-bearing)

- Each builtin mode loads exactly one locked skill.
- Hash mismatch is rejected (loud, no body).
- User `modePrompts` cannot replace the skill body.
- Custom modes do not get a builtin skill.
- Humanizer is present in every builtin composition (and every custom composition).
- Typed Ask default includes locked caveman at full. "stop caveman" / "normal mode" omit it. Auto-Clarity directive fires for irreversible / clarify prompts.
- Settings has no editor for these files.
- Recruiting skill names the interview-sheet cells (track, identity, wishes, job research, mobility, comp, admin, languages, score, portfolio, availability).
- Interview skill is candidate-side (I, first sentence, unlabeled STAR). Recruiting skill is interviewer-side (open question, never yes / no).

## Ready to merge

**READY TO MERGE: no** until Devon Mac-shows Interview, Cold Calling, and Support answers that use the skill, and Settings cannot edit it.
