# Handoff and recovery

This guide covers Teleport's implementation boundaries and recovery behavior.
For installation and everyday use, see the [README](../README.md).

## Tool actions

Teleport exposes one `teleport` tool, not a user-facing slash command.

| Action | Purpose |
|--------|---------|
| `jump` | Move to an existing local directory or `ssh://SSH_ALIAS/absolute/path`. |
| `back` | Return through the recorded route. |
| `history` | List completed moves and managed worktree ownership. |
| `create` | Create and record an owned Git worktree. |
| `remove` | Remove a clean recorded worktree by `resourceId`. |

Create results and history include the resource ID needed for removal. Machine
identity qualifies remote locations and resource ownership, so identical filesystem
paths on different hosts are not treated as the same location.

Pi exposes in-process session replacement only to command contexts. Teleport dispatches
a private one-shot command after `agent_settled`, not while a prompt is running.
That command is transport plumbing, not a supported user API.

## Delayed move output

A queued receipt means only that the move is scheduled. After the move, Teleport
adds a saved outcome beside the initiating call in fullscreen Activity. Nested calls
link to their outer visible call. The full continuation still reaches the agent once,
without a second visible message in Conversation. Native history remains chronological.

The execution link travels with local continuations and remote arrival and return
receipts. It must match the same saved session and active branch; Teleport does not
guess an owner from a path or the last call. Saved outcome entries remain visible
after reload or resume.

Known failures report failure and let the agent continue at the source. An unconfirmed
remote outcome records a warning without starting another model turn. Keep that source
idle and inspect the handoff before retrying, as described below.

## Local handoff

Without Herdr, Teleport records a prepared transition, builds a destination session
with the same session ID and full conversation, and switches Pi to it. It removes
the source session only after the switch succeeds. A hidden continuation starts the
next turn in the destination context. A cancelled or failed switch removes the
prepared destination and leaves the source intact.

## Native Herdr integration

Herdr detection requires `HERDR_ENV=1`, `HERDR_PANE_ID`, `HERDR_TAB_ID`, and
`HERDR_WORKSPACE_ID`, plus the public `herdr` CLI with worktree commands. Teleport
checks the live caller IDs before changing Herdr state. Missing environment values
use ordinary Git creation and in-process switching for local moves. A valid but
unreachable Herdr connection fails rather than silently changing modes.

Local Git checkouts open through `herdr worktree open`. Teleport reuses an idle shell
created by `create`, or creates a separate tab when a workspace has other work.
Plain directories use a new tab in the current workspace. Destination tabs use the
Pi session name, or the destination folder name when no session name exists.

The destination waits for handoff commit before continuing. Teleport confirms the
native process and saves explicit workspace, tab and pane IDs before retiring the
source. Other panes and tabs stay open.

If the source is the last pane in a primary-checkout workspace, Teleport first creates
a shell tab there with `--no-focus`. Linked-worktree and plain-directory workspaces
do not get replacement shells when their last pane leaves.

Remote commands always select the destination's saved Herdr machine. Pane IDs are
server-scoped; inherited local IDs must not identify a remote pane.

## Remote activation and return

Remote preflight runs the destination's configured `pi` from the target directory.
The loaded Teleport fingerprint must match the source implementation. Other packages,
settings, provider credentials and repository contents are not transferred.

A destination readiness callback must match the operation, session ID, session file,
cwd, agent directory and owned pane. Teleport also checks its native foreground
process and resolves the destination's own model authentication before acknowledging
readiness. Only a durable commit releases its continuation and permits source retirement.
A lost readiness reply does not override an already published commit.

A detached controller on the original computer survives source Pi retirement.
A locally initiated SSH connection forwards a private remote Unix socket to this
controller. The callback protocol permits authenticated readiness and return requests,
not arbitrary local commands. It never forwards the raw Herdr socket or opens a public
port. The destination needs no SSH key back to the original computer.

The controller attempts up to three reconnections after a tunnel disconnect.
The original computer must remain available. If reconnection fails, the remote
transcript survives, but automatic return is not guaranteed.

## State and uncertain outcomes

State lives in `$PI_CODING_AGENT_DIR/teleport/<session-id>/state.json`. It records the
active session, completed routes, owned resources and pending transitions. Arrival
and bridge directories alongside it contain preparation and commit receipts.

Local startup reconciliation retains the source of a prepared transition, clears
finished local transitions, and drops missing local sessions or resources. Foreign
resources remain recorded until checked on their owning machine.

Startup readiness, controller responses and commit receipts have no waiting deadline.
The source remains available until the destination reports usable startup. A launch-exit
receipt catches failures even before the first process observation. Slow startup hooks
and temporary observation failures do not trigger rollback.

Known pre-commit failures roll back only the attempted destination and restore the
previous state. Unknown stage, commit, cleanup or return outcomes keep a persistent
source fence: do not resume a second competing agent or blindly retry.

For an unconfirmed handoff:

1. Keep the source idle and preserve its files.
2. Inspect the operation's saved receipt and the exact recorded destination session
   and native Herdr pane. Elapsed time alone proves neither failure nor success.
3. Establish which destination committed before deciding where to continue.
4. Clean up only resources recorded as owned by that operation.

Authenticated return can replace an exact unchanged dormant source retained after
an uncertain outward commit. This exception does not permit replacing other sessions.

## Worktree ownership

Outside Herdr, ownership is recorded before running Git. Inside Herdr, creation uses
`herdr worktree create` and records its returned path and workspace IDs. Herdr chooses
the checkout path unless an explicit path is supplied. Creation from a linked checkout
uses that checkout's commit as the default base.

Removal requires a matching ownership record, Git common directory and clean checkout.
Herdr removal also requires the owning connection and a workspace containing only its
idle shell. A closed workspace can be reopened without focus for removal. Extra panes
or running commands block it. Herdr removes the checkout and idle workspace together.

After removing a worktree, Teleport asks Git to delete its branch with `git branch -d`.
An unmerged branch is not force-deleted.

## Development

```bash
npm test                 # unit tests
npm run typecheck        # TypeScript check
npm run test:integration # real Pi process tests
```
