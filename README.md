# Pi Agent Teleport

A Pi extension that moves one persisted session between directories without leaving duplicate session files behind.

## Install

```bash
pi install npm:@alexshp/pi-agent-teleport
```

## Commands

- `/teleport <directory>` moves the active session to an existing directory.
- `/teleport-wt <branch-or-path>` resolves an existing worktree through optional Worktrunk.
- `/teleport-back` moves to the previous directory.
- `/teleport-history` shows completed moves.
- `/teleport-create <branch> [base] [path]` creates a linked Git worktree owned by Teleport.
- `/teleport-remove <resource-id>` removes a clean worktree recorded as Teleport-owned.

Agents use the `teleport` tool. Moves are queued as follow-up commands because Pi only exposes session replacement to command contexts. An existing Worktrunk worktree is just an existing directory, so `wt switch` output or a Worktrunk path can be passed to `/teleport`; Worktrunk is optional and is never required at runtime.

## Safety model

State is stored under `$PI_CODING_AGENT_DIR/teleport/<session-id>/state.json`. It has a version, one active session, movement history, owned resource manifests, and an in-flight transition. Startup reconciliation chooses only a session file that actually exists and clears interrupted transitions.

A successful in-process move creates the destination session, switches Pi, then deletes the source file. Under Herdr, Teleport creates a destination tab, starts Pi with the destination session, confirms that exact process and session, commits state, removes the source session, then closes the source tab. If confirmation fails, it closes only the new tab and retains the source.

Worktree removal requires a matching Teleport ownership record, matching Git common directory, and a clean worktree. Teleport never removes an unrecorded resource and has no force option.

## Limitations

- Herdr replacement requires `HERDR_ENV`, `HERDR_TAB_ID`, and `HERDR_WORKSPACE_ID`, plus the public `herdr` CLI.
- Teleport cannot transfer in-memory extension state; extensions must restore state from Pi session entries or disk.
- The optional Worktrunk adapter only resolves existing worktrees. It does not create or remove them.
- Dirty managed worktrees must be cleaned manually before removal.
