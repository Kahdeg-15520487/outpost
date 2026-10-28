# The workspace: chats, archive, offline, homepage

The shell around the work: what the bare workspace URL shows, what archiving keeps, what happens
when the backend goes away, and the keys that move the cursor.

## Chats, modules and archiving

**Archiving a module.** ⋯ → *Archive* on a module in the sidebar puts it away: it leaves the sidebar, the workspace home and the agent's `module_list`, and stays out of "Shared with me". Its code, data, shares and link are kept, a direct link (`#/modules/:id`) still opens it, and the workspace's **Archived** section (collapsed, with a count) restores it. Only an owner or editor can archive or restore. Deleting is still the permanent option.

**When the backend is unreachable.** The app notices a closed live connection or a request that gets no answer, shows a banner with how long it has been down and a **Retry now** button, and raises one toast instead of one per failed action. Nothing is disabled: actions still try, and fail with a clear message ("Can't reach Outpost — the server isn't responding…"). It checks every few seconds, says **Back online** when the server answers again, and reloads whatever a failed request left stale. A dropped network is reported as such.

**Chats and modules stay linked.** A chat lists the modules it created or worked on, with **Open** links below its header. Opening a module selects a related chat (keeping the current one if it is related, otherwise the most recent), and the sidebar marks other related items separately from the active item. Browsing the sidebar alone doesn't create links. Existing chats recover links from recorded tool activity; archived chats stay out of navigation.

## Keyboard

The shell takes the same keys as the Slides module: **↓ / → / PageDown / Space / j** move to the next
item, **↑ / ← / PageUp / k** to the previous, **Home / End** jump to the ends, **Enter** opens the
highlighted item and **Escape** drops the cursor. The cursor is the violet outline on sidebar chats,
modules and file rows. Keys never fire while you are typing, and dialogs keep their own keys.

## The workspace homepage

`#/w/<workspace>` — the bare workspace URL, or the **π** logo in the sidebar — is the workspace's
homepage, not a chat. Chats live at `#/w/<ws>/c/<id>`. The page answers two questions:

- **Where was I?** The last chat, missions with questions waiting on you, approvals to decide — one
  click each — plus quick actions to start a chat or give a team a goal.
- **What happened while I was away?** What the agents did since you last opened the workspace: runs per
  chat (messages, which tools, a snippet of what it said), missions that moved, modules edited,
  approvals decided, files added.

"While you were away" measures from the last time *you* opened the homepage, stored per user; a
workspace you have never opened looks back a week.

Chat transcripts carry no wall-clock time of their own — a durable entry is an ordered record, not a
timestamped one — so every finished agent run is written down as it ends, from the run's own event
stream, whether or not anyone has the chat open. That record is deliberately small: counts, tool names
and the agent's last words, capped at the newest 300 runs.

The digest itself is facts only and costs nothing. **Summarise these chats** asks the model for one
line per chat, caches it until that chat has newer runs, and is skipped on the demo model. What is sent
to the model is the run snippets and tool names, never the transcript.
