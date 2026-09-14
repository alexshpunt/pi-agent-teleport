# Changelog

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
