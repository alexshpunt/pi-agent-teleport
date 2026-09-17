<p align="center">
  <img src="assets/agent-portal.webp" alt="Pi Agent Teleport" width="760">
</p>

<h1 align="center">Pi Agent Teleport</h1>

<p align="center">Move a running Pi Coding Agent session between directories, repositories, and isolated Git worktrees.</p>

<p align="center"><em>Give your agent a teleportation gun.</em></p>

<p align="center">
  <a href="https://www.npmjs.com/package/pi-agent-teleport"><img src="https://img.shields.io/npm/v/pi-agent-teleport" alt="npm version"></a>
  <a href="https://www.npmjs.com/package/pi-agent-teleport"><img src="https://img.shields.io/npm/dm/pi-agent-teleport" alt="npm downloads"></a>
  <a href="https://github.com/alexshpunt/pi-agent-teleport/actions/workflows/ci.yml"><img src="https://github.com/alexshpunt/pi-agent-teleport/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/npm/l/pi-agent-teleport" alt="MIT license"></a>
</p>

Pi normally lives in the directory where you started it. Teleport lets the agent move
the running session to another directory, another repository, or a fresh Git worktree —
and jump back when the job is done. The conversation continues and the session stays the same.

```text
✦ Agent teleport
  /root/dev/pi/pi-worktrunk                ← from (blue)
  └─→ /root/dev/pi/pi-agent-teleport       ← to (orange)
```

The agent keeps working after the move. You see one compact route row, not a new user
message.

## Install

```bash
pi install npm:pi-agent-teleport
```

## Use it

Ask the agent to move or isolate the work:

```text
Move this session to /root/dev/my-other-repo and continue there.

Create an isolated worktree for the login fix, move into it, and continue the task.

Go back to the previous repository and remove the worktree you created.
```

The agent calls Teleport itself. You do not need to remember a slash command or tool syntax. Teleport requires a persisted Pi session.

## What it gives the agent

Teleport exposes a single `teleport` tool. There are no user-facing slash commands.

| Action    | Purpose |
|-----------|---------|
| `jump`    | Move the session to an existing directory. |
| `back`    | Move the session to the previous location. |
| `history` | List completed moves. |
| `create`  | Create a linked Git worktree owned by Teleport. |
| `remove`  | Remove a clean worktree recorded as Teleport-owned. |

Typical flow:

```text
create worktree → jump into it → do the work → back → remove the worktree
```

## How a move works

1. Teleport writes a `prepared` transition to durable state.
2. It builds the destination session: same session id, updated `cwd`, full conversation.
3. It switches Pi to the destination session.
4. Only then it removes the source session file.
5. A hidden continuation starts the next agent turn inside the destination context.

If step 3 is cancelled or fails, Teleport removes the prepared destination and keeps the
source untouched.

Under Herdr, the replacement is stronger. Teleport creates a destination tab, starts Pi
with the destination session, waits until Herdr reports that exact process and session,
commits the state, schedules the source session removal, and closes the source tab. If
confirmation fails, it closes only the new tab and keeps the source.

## Managed worktrees

`create` registers ownership before it creates anything. `remove` requires all of these:

- a matching Teleport ownership record,
- a matching Git common directory,
- a clean worktree.

Teleport never deletes an unrecorded resource, and it has no force option. After removing the worktree, Teleport asks Git to delete the branch with `git branch -d`.
Git deletes a safely merged branch and refuses to delete an unmerged one.

## State and recovery

State lives in `$PI_CODING_AGENT_DIR/teleport/<session-id>/state.json`. It holds a version,
the active session, movement history, owned resources, and any in-flight transition.

On session start Teleport reconciles that state:

- a `prepared` transition keeps the source, even when the destination file already exists;
- a confirmed destination becomes the active session;
- transitions are cleared, and a missing active session or resource is dropped.

## Requirements

- Pi 0.80 or newer.
- Node.js 22 or newer.
- Herdr replacement needs `HERDR_ENV`, `HERDR_TAB_ID`, and `HERDR_WORKSPACE_ID` plus the
  public `herdr` CLI. Without Herdr, Teleport uses in-process session switching.

## Limitations

- Teleport cannot carry in-memory extension state. Extensions must restore state from Pi
  session entries or from disk.
- Pi exposes session replacement only to command contexts, so `jump` and `back` use a
  private one-shot command as transport. It is plumbing, not a supported user API.
- Dirty managed worktrees must be cleaned manually before removal.
- A worktree is checkout isolation, not a security sandbox.

## Development

```bash
npm test            # unit tests
npm run typecheck   # TypeScript check
npm run test:integration  # real Pi process test
```

## License

MIT
