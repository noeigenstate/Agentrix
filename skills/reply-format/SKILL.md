---
name: reply-format
description: Use for every reply to the owner in this project (status reports, failure reports, answers about work in progress), by the lead and by every worker whose output the owner reads. Replies use the owner-chosen format C, "status table plus notes" - a verdict line, one Item/State/Detail table, up to four short notes - so they read well in Agentrix's unchanged reading view.
---

# Reply format: status table plus notes (format C)

The owner chose this format on 2026-11-15 after comparing five formats rendered in the reading view. The reading view itself stays as it is: improve readability through what the reply says and how it is structured, never by proposing reading-view layout changes.

## Shape
1. **First paragraph: the verdict and what the owner must do.** State the current state in 25 words or fewer, true at the moment of sending. Then say what the owner must do, or "Nothing needed from you."
2. **One table, three columns:** `Item` (or `Step` for a sequence) | `State` | `Detail`. Three to six rows.
   - `State` is one word from this set only: Done, Passed, Running, Waiting, Failed, Blocked.
   - A `Detail` cell holds at most 20 words. Commit hashes and run numbers go here, in brackets.
3. **Up to four short notes under the table,** for what a cell cannot hold: a cause, a short list, an owner's choice. Plain sentences. Lists have one level.
4. **An update lists only the rows whose state changed** since the last message.

## Rules shared with every format
- Use no internal codes: no lane letters, round or wave numbers, worker nicknames or module jargon. Write the plain description instead, such as "the automatic Codex search".
- Use no bold for labels. Bold is allowed only for something the owner must do.
- A fact appears once per message.
- If the state changes while you are writing, say so in a new message.
- Order for a failure: what failed, cause, fix, proof, what happens next. Order for status: done, proof, waiting on what, other work. Every report still states execution logic, cause, fix and result with evidence.
- Numbers say what they count: "all 579 related tests pass, 39 skipped", not "tests green".
- Product text that is Chinese in the app is given as the English meaning with the Chinese in brackets, for example: Faster status reports (状态汇报更快).
- When the content is one chain of cause and effect, such as a single failure, keep the table to the steps and put the cause and fix in the notes.
- A finished task still ends with the 【交付】 block and its three fixed labels: 问题/原因/结果 for a fix, or 优化/解决/对比 for an optimization. Write one or two plain sentences each, leave a blank line between the lines, and put nothing after the block. Agentrix reads the block to fill the task's homework card. The reading view hides it under the reply (owner decision 2026-11-15), so it does not show twice. Do not repeat its sentences in the visible reply on purpose.

## Check before sending
- The first paragraph is 25 words or fewer and says what is needed from the owner.
- There is exactly one table, with 3–6 rows, and every State comes from the fixed set.
- There are at most four notes, no nested lists, no label bold and no internal codes.
