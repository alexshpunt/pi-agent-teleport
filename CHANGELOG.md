# Changelog

## 0.2.8 - 2026-10-28

- Wait for destination Pi startup without a time limit. Cancel on a reported startup failure or an observed process exit, keeping the source session usable.
- Preserve the active agent profile when moving between local Herdr panes.
- Stop the source tool batch before a queued move and preserve queued instructions, so subsequent relative file operations run in the destination directory.
- Launch and retire Pi sessions in Windows Herdr PowerShell panes with literal paths, arguments and environment values. Accept equivalent Windows directory spellings while retaining exact process and session checks.

## 0.2.7 - 2026-10-21

- Keep delayed move outcomes beside their originating Teleport calls, including calls nested inside another tool, without duplicate output in Conversation.
- Carry execution ownership through local moves and remote arrival/return handoffs while preserving the full continuation delivered to the agent.
- Reject outcomes from a different session or abandoned branch rather than guessing which call owns them.
- Show unconfirmed remote outcomes as warnings without waking a competing agent, preserving existing recovery safeguards.
- Require Pi 1.3 or newer.
- Add regression coverage for delayed ownership and delivery; run the session-replacement round trip in its own Pi process while leaving other integration tests on the shared runner.

## 0.2.6 - 2026-10-18

- Move the same Pi session to a remote Herdr machine over SSH and return with its conversation intact.
- Use destination-owned settings and authentication; allow different Pi versions without changing either installation.
- Check destination Teleport readiness before retiring the source and preserve uncertain handoffs for inspection.
- Avoid leaving replacement shells in departed worktree and plain-directory Herdr workspaces.
- Keep the README user-facing and include the separate technical guide in the npm package.
- Require Node.js 22.19 or newer.

## 0.2.5 - 2026-10-02

- Close only the source agent pane during teleport, keeping other panels and tabs open.
- Create a background shell before closing the last source pane, so its Herdr workspace stays open.

## 0.2.4 - 2026-10-02

- Start destination Pi processes with `--approve` to avoid project-trust prompts during teleport.

## 0.2.3 - 2026-10-02

- Name Herdr destination tabs after the Pi session, or the destination folder when unnamed.

## 0.2.2 - 2026-10-02

- Create and open worktrees as grouped Herdr workspaces, using Herdr's configured checkout paths.
- Save Herdr workspace, tab, and pane IDs and safely remove idle worktree workspaces.
- Wait for the current agent turn to settle before moving the session, avoiding overlapping prompts.
- Accept empty successful Herdr command replies instead of failing to parse them as JSON.
- Keep removed worktree history readable after a session move.

## 0.2.1 - 2026-09-27

- Show the resource ID after creating a worktree and in history, so the agent can remove it later.
- Explain that removing a worktree requires its resource ID.

## 0.2.0 - 2026-09-18

- Close the source agent session immediately after a confirmed Herdr handoff.
- Keep destination tabs in the background instead of taking focus from the user.
- Show worktree paths and branches in create and remove results instead of internal resource IDs.

## 0.1.10 - 2026-09-17

- Add search terms for common coding-agent, Git, and repository workflows.

## 0.1.9 - 2026-09-17

- Follow Pi package dependency rules and improve package discovery metadata.
- Add practical first-use examples and clearer product positioning.
- Publish only runtime source files.

## 0.1.8 - 2026-09-17

- Keep the agent working in its current location after any queued teleport fails.
- Show the teleport error in the TUI before starting the next agent turn.

## 0.1.7 - 2026-09-15

- Keep the agent running when a teleport destination does not exist and tell it to find the correct path.
- Render failed teleports as errors instead of successful handoffs.

## 0.1.6 - 2026-09-14

- Restore compact WebP artwork after verifying Pi Gallery supports the format.
- Pin the gallery image to the release tag instead of the moving main branch.

## 0.1.5 - 2026-09-14

- Use PNG for the Pi gallery preview so the gallery can render it reliably.

## 0.1.4 - 2026-09-14

- Keep the transparent logo at its stable URL while reducing it to about 60 KB.
- Keep the separate 16:9 Pi gallery preview at about 37 KB.

## 0.1.3 - 2026-09-14

- Add a compact 16:9 Pi gallery image on a matching dark background.
- Compress the transparent README logo and reduce the package size.

## 0.1.2 - 2026-09-14

- Add Pi package gallery metadata and use the portal logo as its preview image.

## 0.1.1 - 2026-09-14

- Teach agents when to use Teleport instead of changing directories in a shell.
- Add trusted npm publishing through GitHub Actions and OIDC.

## 0.1.0 - 2026-09-14

- Add persisted session jumps, back navigation, and history.
- Add safely owned Git worktree creation and removal.
- Add confirmed replacement handoffs when running under Herdr.
- Add versioned state and startup reconciliation.
- Render teleport routes in the TUI with portal colors.
- Continue the agent automatically after a move without a visible user message.
