---
name: reading-timeline
description: Use when changing the reading view's conversation hierarchy, timeline nodes, nested tool groups, or how earlier conversation pages join an agent turn.
---

# Agent turns own their execution steps

The main rail represents user messages and agent turns. Skills, commands and other tools are children of the
agent that executes them, with a smaller mark and an inset branch. Keep assistant text and tools in their original
order beneath one agent heading; leading tools and tools-only turns still need that heading. Preserve names,
timestamps, expansion, running/failure states and generated file cards.

- `useVisibleTail.ts`: group consecutive tools into blocks, page those blocks, then use `conversationTurns` to
  nest the visible blocks. Read earlier blocks for the parent's stable identity and starting time, without
  rendering them. `conversation-buffer.ts` reconciles turn and tool-group identities before its 400-entry cap,
  using `reading-timeline-identity.ts` and overlapping record IDs. Keep metadata on retained objects rather than
  an unbounded ID registry. Test prepending, rolling eviction, fresh snapshots and genuine user/session boundaries.
- `ReadingView.tsx` and `Timeline.tsx`: render the parent with `TimelineStep` and children with `AgentTurnItem`.
  Attach live status to its current agent turn. A user message starts a new boundary. Transcript-only queued
  messages still need pending cards; pair them one-to-one with local echoes and do not resend accepted queue entries.
- `reading-flow.css`: scope main-rail and child-branch selectors separately. Check theme overrides before changing
  sizes or colors, and preserve the reading column's alignment with the composer.

Validate with `node --test tests/visible-tail.test.cjs tests/reading-ui.test.cjs`, a build, then
`node scripts/reading-hierarchy-smoke.mjs`. The GUI check uses an isolated profile and covers leading tools,
stream updates, rolling eviction, transcript queues, both agents, Catalina and compact cards. It also
checks file-popup pagination and delayed autosave. Inspect its screenshots; `--packaged` uses the built Windows app.
