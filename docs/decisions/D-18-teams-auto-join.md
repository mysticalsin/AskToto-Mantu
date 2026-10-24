# D-18: Teams auto-join

**Status:** Excluded from 2.12.

## Decision
Métis 2.12 does not join Microsoft Teams meetings by itself. There is no bot, no automatic join and no setting that
suggests one.

## What ships
- The Agenda "Join" link: a link you click yourself to open the meeting.
- Post-meeting enrichment: speaker names from the Teams transcript are added when your account can read it. This
  uses read-only transcript access and is unchanged.

## What does not ship
- Joining a meeting on your behalf, or capturing a Teams call through calling or media APIs.

## Why
Joining needs a Microsoft Entra tenant the owner controls, an app registration with calling permissions, tenant
admin consent, and a hosted media endpoint. None of that exists, so a join feature would be a stand-in, not a
working capability.

## Enforcement
`src/main/teams-auto-join-disposition.contract.test.ts` fails if source adds a calling or online-meeting API,
a join-URL open from the main process, or an auto-join setting key.

## What would re-open it
A new owner decision superseding D-18, plus a test tenant with the app registration and admin consent in place.
Join, capture and enrichment would then be designed as three separate states.
