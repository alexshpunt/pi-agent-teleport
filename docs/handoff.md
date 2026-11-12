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

Pi exposes in-process session replacement only to command contexts. When a move is
queued, Teleport lets every sibling tool finish in the source folder, then aborts
the response loop at `turn_end`. This also handles moves issued alongside Codemode:
Pi only honors a tool's `terminate` result when every sibling agrees to terminate.
If messages are already queued, Teleport leaves Pi's delivery policy unchanged:
Pi processes the queue at the source before the move. It does not abort that turn,
because TUI abort clears the full queue while the public preview exposes only the
next message.

Teleport dispatches a private one-shot command after `agent_settled`, not while a
prompt is running. That command is transport plumbing, not a supported user API.

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

Local moves stay in the current Pi terminal, whether or not Herdr is running.
Teleport first checks startup in the destination, then records a prepared transition,
builds a destination session with the same session ID and full conversation, and
switches Pi to it. It removes the source session only after the replacement runtime
restores the selected model, thinking level and authentication. A hidden continuation
starts the next turn in the destination context. If restoration fails, Teleport
retains the source and attempts to switch back; an unsuccessful rollback retains
both session files.

## Native Herdr integration

Local moves and worktree operations do not require Herdr and do not open or close
its panes or tabs. For remote moves, Teleport checks the caller's live IDs and, for
Herdr App, verifies that the addressed window contains the source terminal before
changing its UI. An unreachable or mismatched route stops the move.

On native Windows, Teleport sends an encoded PowerShell launch script and runs the
current Pi installation directly. This preserves literal Windows paths and handoff
environment values, and lets Herdr observe Pi's own readiness PID instead of an npm
wrapper. Windows handoffs do not require a POSIX shell.

For remote handoffs, if the source is the last pane in a primary-checkout workspace,
Teleport first creates a shell tab there with `--no-focus`. Linked-worktree and
plain-directory workspaces do not get replacement shells when their last pane leaves.

Remote commands select the destination's saved Herdr machine. If the destination
hosts the App window for a remote source, Teleport instead verifies the source's
workspace, tab and terminal against that window and uses its local desktop. Pane IDs
are server-scoped; inherited local IDs must not identify a remote pane.

### Herdr App adapter

The App adapter resolves `HC_TERMINAL_ID` through the owning `hc` connection and
verifies its space/tab labels. It uses public App commands for names and layout;
Git manages worktrees. Creation first requests `focus:false`. Only the running
window's pre-execution rejection of that unsupported argument permits retrying
with App's default focus behavior. A timeout or lost reply is never replayed.

Worktree ownership is saved before requesting an App space. An unconfirmed UI
result retains that ownership for recovery. Removal requires the recorded sole
idle terminal; it parks that terminal and waits for the UI acknowledgment before
ending it. Other terminals and mod panes prevent checkout removal.

Linux process observation checks the complete foreground group in the shell's
session, including wrappers, and reads each process's current directory from the
OS. The observer needs permission to read those processes' `/proc` entries; a
separate user namespace can prevent this even with the same numeric UID.

Native Windows uses 64-bit Windows PowerShell and a read-only process-tree
observer. It reads live PID, current directory and argv from process memory,
checks creation times and repeated snapshots, and reports an explicit idle/busy
verdict: ConPTY has no Unix foreground group. The observer excludes itself and
identifies the system console host by its native executable path, not its name.
Other descendants, including user programs named conhost.exe, remain occupants.
An unreadable or changing descendant, including WOW64, is busy/unknown; an
unreadable root is an error. The child PowerShell's execution policy applies only
to that process and does not change host settings.

Local App handoffs launch the current Node executable and Pi entry point directly,
preserving runtime flags and the captured agent directory. A login-shell `pi` wrapper
cannot replace that profile at the destination. Legacy Unix launches are unchanged.

App source retirement runs in a detached worker with the saved connection and
without the source terminal's sweep scope. It verifies the recorded PID, current
directory and session argument, or confirms that the source exited and its shell
is idle, before closing the terminal. The source transcript is removed only after
process exit. Failed cleanup retains it and records the worker outcome under the
session's `cleanup` directory.

Remote App creation uses the persistent direct SSH profile from `hc machine ls`.
Its name qualifies UI handles; native core handles remain unqualified and bound to
their captured connection. Lists and creation receipts cannot adopt another
machine's handles. UI requests travel through the authenticated Teleport controller,
which permits only the addressed machine's creation, naming, closure, parking and
listing commands. SSH endpoint calls are asynchronous so staging can call back to
the controller. The return channel stays available until remote App source cleanup
acknowledges retirement.

A Pi started manually in a remote App terminal has no inherited controller. Give it
an explicit desktop SSH route: save a private JSON file on that remote machine and
set `PI_TELEPORT_APP_CONTEXT` to its absolute path before starting Pi.

```json
{
  "backend": "app",
  "session": "default",
  "appMachine": "worker",
  "appSsh": { "target": "desktop-ssh", "session": "default" }
}
```

The outer `session` is the remote terminal's core session. `appMachine` is this
remote machine's profile name in the desktop's `hc machine ls`, not its SSH target
or permanent host ID. `appSsh.target` is an existing trusted OpenSSH alias on the
remote machine. The desktop needs Node and the public App CLI on its SSH login
PATH. `appSsh.session` selects the desktop's core/App session; it defaults to
`default`. For a custom desktop installation, `appSsh` also accepts `appCli`,
`appHome`, `stateHome`, `configHome`, `runtimeDir` and `coreSocketPath`. These desktop
settings are separate from the remote core's environment. SSH host-key checks stay
enabled and the SSH agent is never forwarded. No public App endpoint is added.

Native App process observation is not implemented on macOS. App operations that
require foreground ownership fail closed there. The legacy integration above is
unchanged.

## Remote activation and return

Remote preflight runs the destination's configured `pi` from the target directory.
The loaded Teleport fingerprint must match the source implementation; checkout line
endings do not affect the fingerprint. The probe stops after three minutes if Pi has
not exited. Other packages, settings, provider credentials and repository contents
are not transferred.

A destination readiness callback must match the operation, session ID, session file,
cwd, agent directory and owned pane. Teleport also checks its native foreground
process, restores the source's selected provider, model ID and thinking level after
all startup hooks, and resolves that selection's authentication before acknowledging
readiness. It rejects a fallback or unavailable authentication and retains the source.
Only a durable commit releases its continuation and permits source retirement.
A lost readiness reply does not override an already published commit.

For a virtual model, Teleport verifies the virtual selection and its provider's
authentication. The router can choose different physical models for later requests,
so this check cannot establish credentials for every possible route.

For Herdr App, the controller and cleanup workers run in unparented core terminals
that outlive the source pane and are removed when they exit. The authenticated
controller listens on a private Unix socket, or a loopback TCP port on Windows.
A locally initiated SSH connection forwards a private remote Unix socket to it. For a
Windows destination, it forwards a dynamically assigned loopback TCP port instead.
Teleport waits for SSH to confirm the forward before staging an arrival and reconnects
using the same port. The callback protocol permits authenticated readiness and return
requests, not arbitrary local commands.
It never forwards the raw Herdr socket or opens a public port. The destination needs
no SSH key back to the original computer. After a desktop return, the controller uses
an independent SSH process to retire the Windows source outside its terminal job.

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

After a confirmed remote handoff, transcript cleanup runs separately from pane cleanup.
It waits for the source process to exit and removes only the recorded file identity. If
the process remains alive, the file was replaced, or cleanup cannot be confirmed, the
transcript is retained for inspection.

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

Ownership is recorded before running Git. Unless a path is supplied, the checkout
is created beside the source checkout using the source directory and branch names.
Creation from a linked checkout uses that checkout's commit as the default base.

Removal requires a matching ownership record, machine, repository, Git common
directory and clean checkout. Git removes the checkout without inspecting or closing
Herdr panels, including for older records containing Herdr metadata. Close or move
other programs using the checkout before removing it.

After removing a worktree, Teleport asks Git to delete its branch with `git branch -d`.
An unmerged branch is not force-deleted.

## Development

```bash
npm test                 # unit tests
npm run typecheck        # TypeScript check
npm run test:integration # real Pi process tests
```

The launcher regressions in `src/launch.test.ts` execute real shell commands.
PowerShell cases use Windows PowerShell on Windows and `pwsh` on Unix; they skip
when that shell is unavailable.
