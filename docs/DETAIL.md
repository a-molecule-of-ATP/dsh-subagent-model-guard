# Subagent Route Guard

The subagent route guard validates the `provider/model` a subagent will actually run on before dispatch, using allow-lists, a blacklist, and two optional checkpoints to control "who may delegate to whom".

> **Terminology (read this first)**
> - **Arguments** are passed by the agent on each dispatch and apply to that dispatch only, e.g. `provider`, `cwd`.
> - **Settings** are configured by you on the plugin page and persist across dispatches, e.g. `enforcement`, `replaceSubagentTool`.

## What problem it solves

DSH's official subagent allow-list (`subagent-model-selection-settings`'s `allowedModels`) is frozen into a snapshot when a session starts: a model published while a session is open cannot be used in that old session. This plugin solves exactly that, and adds an explicit "who may delegate to whom" policy — you decide which routes are allowed and which are explicitly denied. The official list is read live through `subagentModelSelection.current()` and recomputed on every check, so edits to the official allow-list and to this plugin's config take effect immediately, with no reload.

## What a dispatch passes through

![What a dispatch passes through](dispatch-path.svg)

The two right-hand exits differ: an unresolvable route passes through with a log entry, while a route on the official list simply passes. When the official list is empty or the service is unavailable the guard is inactive and no verdict is reached at all. `enforcement` only chooses where the check runs.

## The allow-list is the official one

This plugin keeps **no list of its own**. On every dispatch it reads the DSH
subagent model selection (`allowedModels`, via `subagentModelSelection.current()`),
so an edit in the DSH settings takes effect immediately without a reload.

That leaves exactly one place to decide who may be delegated to:

- **Non-empty official list** — only those routes may be dispatched; everything
  else is refused.
- **Empty list, official `enabled` off, or service unavailable** — no restriction
  is applied, matching DSH's native behaviour. The guard never invents a policy
  you did not configure.
- **To block a model** — remove it from the official list. This plugin has no
  blacklist and no wildcard.
## Choosing a checkpoint

`enforcement` is a setting (configured on the plugin page, persisting across dispatches) that decides where to validate; it defaults to `agent-created`:

- **`agent-created`**: validates at the `agent/created` event. Stable contract and covers `agent()` inside workflows; the cost is that a refusal leaves an empty session record behind.
- **`start-activation`**: wraps `ctx.subagents` and refuses before the agent is constructed — zero residue; the cost is a dependency on the internal `internal/get` hook.
- **`both`**: validates at both points, trading zero residue for double coverage.

Both gates are always registered and behave according to live `enforcement`; the fields are volatile, so a settings write needs no reload.

## The replacement tool

![One call, two paths, two outcomes](snapshot-vs-replacement.svg)

`replaceSubagentTool` is a setting (configured on the plugin page, persisting across dispatches, off by default); it replaces the official `subagent` tool with this plugin's own (a scoped shadow), letting subagents go straight to `startActivation` and bypass the snapshot frozen at session start — newly published models become usable immediately even in old sessions.

The cost is that it shadows only `subagent`: `subagent_fork` keeps the official tool and stays bound by the same session model snapshot. The replacement is registered into each agent scope at `agent/created`, with a catch-up pass for agents that already exist.

## Typical usage

The list lives in **DSH's own subagent model selection settings**; this plugin page does not offer it. Matching there is exact — there is no wildcard.

**Allow only some models** — list them in the official settings; this plugin follows immediately.

**Make a new model usable in old sessions immediately** (enable the replacement tool so it bypasses the snapshot frozen at session start):
```json
{
  "replaceSubagentTool": true
}
```

**Switch the guard off temporarily** (for diagnosis; everything passes):
```json
{
  "strict": false
}
```

## Self-check

`guard_selfcheck` is a read-only diagnostic tool with no parameters that changes nothing. It reports whether the guard is active (`active`), the strict flag and `enforcement` mode, what the official allow-list returned, the effective route count, the state of both gates and the replacement tool, the recent denial count, and a per-item `checks` array. **The settings page now ends with a 自检 card whose "运行自检" button hits the same read-only route and runs the same check**, so the button and the tool can never report differently; the route is not registered when the host has no web server, in which case the button reports that it cannot fetch the data.

Its `officialAllowList` distinguishes three states to help answer "why was this route allowed/refused":

1. **Service unavailable**: `available:false` with an `error` (`subagentModelSelection` not mounted or missing `current()`);
2. **Official `enabled:false`**: `available:true, enabled:false`, an empty list, **no** `error` (a normal state — the official list imposes no restriction);
3. **Official enabled but empty** (`current()` throws): `available:true`, `error` set, an empty list.

Reach for it when a new model will not work, a route is unexpectedly allowed, or you want to confirm the guard is really in effect.

## Known limitations

- External acp/SDK backends do not fire `agent/created` and expose no local provider/model; in that case the guard cannot determine the route and **allows and records** it (fail-open) rather than hard-refusing.
- Per-step auditing (`auditEveryStep`, default off) only writes logs and never blocks: reaching the model-call step means the creation-time check was bypassed, and refusing there would surface as "created successfully but fails immediately", so it only leaves a trace.
- The recent-denial records live only in process memory (`recentDenialLimit` defaults to 0) and are never persisted — a denial's reason contains a model name, which is private.
