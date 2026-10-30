# Phones and tablets

Outpost is a workspace you can open on a phone: read a chat on the train, approve a queued write, look
at what a mission built. The same app, one stylesheet (`packages/web/src/responsive.css`) and one small
piece of state for the navigation panel.

Nothing here is a separate mobile app or a second layout engine. Above the breakpoints the desktop
layout is the layout; below them the same DOM rearranges itself.

## The three breakpoints

| Width | What changes | Why there |
|---|---|---|
| ≤ 1100px | A module opened beside a chat takes the window; the chat stays mounted behind it | Three columns no longer leave a usable module |
| ≤ 960px | The sidebar leaves the grid and becomes a panel over the page; every screen grows a menu button in its header; page padding tightens; a module takes the whole window | A 250px sidebar plus content is not a tablet |
| ≤ 700px | One column everywhere; dialogs become bottom sheets; the team becomes a sideways strip; files table drops to name + actions; the composer sits above the home indicator | A phone in portrait |
| ≤ 520px | Everything that was still side-by-side stacks | A narrow phone |
| Short landscape (≤ 480px tall) | The chat greeting shrinks and suggestions go two-up | The header would otherwise eat the screen |

## The navigation panel

Below 960px the sidebar is off-canvas: `position: fixed`, slid out by `transform`, with a scrim behind
it. Each screen puts a `NavToggle` button in its own header row — the chat's topbar, the home
eyebrow, `Files`, `Blueprints`, `Connections`, `Settings`, and the mission header — so the menu is
reachable from wherever you are rather than from one app-wide bar.

The state lives in `packages/web/src/nav.ts`, outside React, because those headers are in different
component trees:

- tapping the button toggles the panel,
- following any link closes it (`hashchange`),
- `Escape` closes it,
- the page behind it cannot scroll while it is open (`body.nav-locked`).

Above 960px the same component is `display: none` and the sidebar is a normal grid column, so desktop
behaviour — including "hide the side panel", remembered per browser — is untouched.

## The module window

A module opened from a chat covers the window on a phone instead of splitting it. The chat is hidden
but stays mounted, so drafts, scroll position and a running agent survive the trip. The ✕ in the
module's bar comes back to the chat; the tab strip wraps to a second row and scrolls.

Module *content* is the module's own business: a blueprint written for a wide screen will still look
wide inside a 390px frame. The chrome adapts; what runs in the frame is up to whoever wrote it.

## Dialogs and drawers

Every in-app dialog keeps its markup and becomes a bottom sheet under 700px: full width, pinned to the
bottom edge, `max-height: 92dvh`, rounded top corners, and padding that respects
`env(safe-area-inset-bottom)`. The approvals drawer and the item panel go full width. Escape and the
scrim still close them.

`max-height: 92dvh` rather than `vh`: on a phone the browser's own toolbars come and go, and `vh`
measures the largest viewport — a sheet sized with it hides its footer behind the toolbar.

## What is deliberately not shrunk

- **Text fields are 16px.** Anything smaller and iOS zooms into the field on focus, then never zooms
  back out.
- **Targets grow on touch screens.** `@media (hover: none)` gives buttons, tabs, sidebar rows and menu
  items thumb-sized padding, and shows the affordances that hover would otherwise reveal (the ⋯ on a
  chat row, the copy button in a JSON tree).
- **A wide table scrolls itself**, never the page: the files table gives up its columns (kind, size,
  origin, date) instead of scrolling sideways to reach its buttons, and document tables keep
  `overflow-x: auto`.
- **The app is never `100vh` tall.** `100dvh` where supported, so the composer is not behind the
  browser's toolbars.

## How it is checked

`packages/server/test/ui.ts` ends with a phone pass that drives the built app at 390×844, 768×1024,
1280×900 and 844×390:

- no screen asks for a sideways scroll (`scrollWidth ≤ clientWidth`) — home, chat, files, blueprints,
  settings, connections, mission overview, backlog;
- the sidebar is off the screen, the menu button slides it in over a scrim, Escape closes it, and
  following a link closes it too;
- a dialog is a full-width sheet whose bottom edge is the viewport's;
- the composer's font-size is ≥ 16px and a long list of module chips scrolls rather than stacks;
- a module covers the window, and its close button returns to the chat;
- a laptop keeps the sidebar in place with no menu button.

`SHOTS=<dir>` saves the screenshots these checks take, if you want to look at them.
