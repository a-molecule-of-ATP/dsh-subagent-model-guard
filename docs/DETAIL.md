# Subagent Route Guard

The subagent route guard validates the `provider/model` a subagent will actually run on before dispatch, using allow-lists, a blacklist, and two optional checkpoints to control "who may delegate to whom".

## What problem it solves

DSH's official subagent allow-list (`subagent-model-selection-settings`'s `allowedModels`) is frozen into a snapshot when a session starts: a model published while a session is open cannot be used in that old session. This plugin solves exactly that, and adds an explicit "who may delegate to whom" policy — you decide which routes are allowed and which are explicitly denied. The official list is read live through `subagentModelSelection.current()` and recomputed on every check, so edits to the official allow-list and to this plugin's config take effect immediately, with no reload.

## What a dispatch passes through

```
  subagent / subagent_fork dispatch
             |
             v
  +---------------------------+
  | 1. Is the route known?     |
  |    provider/model missing?|
  +------------+--------------+
       known   |   unknown
               v            v
   +----------------+   +---------------------------+
   | 2. deniedRoutes|   | Allow + record (no hard   |
   |    blacklist?  |   | refusal) — external       |
   +-------+--------+   | acp/SDK backends never    |
   hit    |   no hit    | fire agent/created        |
     v        v         +---------------------------+
   refuse   +------------------------------------+
            | 3. Allow-list: official allowedModels |
            |    + plugin routes, merged live and   |
            |    de-duplicated (both empty => no    |
            |    enforcement)                      |
            +------------+-----------------------+
               hit   |   no hit
                  v       v
               +-------------+
               | 4. Checkpoint|
               | agent-created|
               | or          |
               | start-activation (optionally both)|
               +------+------+
                      v
                 allow / refuse
```

## Allow-list vs. blacklist priority

The allow-list has two sources: the official `allowedModels` read when `useOfficialAllowList` is on (default), plus this plugin's own `routes`. They are merged and de-duplicated live. Only when both are empty is nothing blocked.

`deniedRoutes` is an explicit blacklist that outranks every allow-list, including the official `allowedModels`: a matching route is refused even if it also appears on an allow-list. The reason is that an explicit denial is a deliberate "no" — if you specifically listed a route as denied, its presence on any allow-list is an oversight and must not override the denial.

## Choosing a checkpoint

`enforcement` decides where to validate; the default is `agent-created`:

- **`agent-created`**: validates at the `agent/created` event. Stable contract and covers `agent()` inside workflows; the cost is that a refusal leaves an empty session record behind.
- **`start-activation`**: wraps `ctx.subagents` and refuses before the agent is constructed — zero residue; the cost is a dependency on the internal `internal/get` hook.
- **`both`**: validates at both points, trading zero residue for double coverage.

Both gates are always registered and behave according to live `enforcement`; the fields are volatile, so a settings write needs no reload.

## The replacement tool

![One call, two paths, two outcomes](snapshot-vs-replacement.svg)

`replaceSubagentTool` (default off) replaces the official `subagent` tool with this plugin's own (a scoped shadow), letting subagents go straight to `startActivation` and bypass the snapshot frozen at session start — newly published models become usable immediately even in old sessions.

The cost is that it shadows only `subagent`: `subagent_fork` keeps the official tool and stays bound by the same session model snapshot. The replacement is registered into each agent scope at `agent/created`, with a catch-up pass for agents that already exist.

## Typical usage

**Allow only one model** (keeping the official list):
```json
{
  "useOfficialAllowList": true,
  "routes": [{ "provider": "workbuddy", "model": "hy4flash-free" }]
}
```

**Ban a provider family** (the blacklist wins even if it is allow-listed):
```json
{
  "deniedRoutes": [{ "provider": "untrusted", "model": "*" }],
  "routes": [{ "provider": "untrusted", "model": "*" }]
}
```

**Make a new model usable in old sessions immediately** (enable the replacement to bypass the frozen snapshot):
```json
{
  "replaceSubagentTool": true,
  "routes": [{ "provider": "workbuddy", "model": "brand-new-model" }]
}
```

## Self-check

`guard_selfcheck` is a read-only diagnostic tool with no parameters that changes nothing. It reports whether the guard is active (`active`), the strict flag and `enforcement` mode, the official and plugin allow-lists, the `deniedRoutes` blacklist, the effective route count, the state of both gates and the replacement tool, the recent denial count, and a per-item `checks` array.

Its `officialAllowList` distinguishes three states to help answer "why was this route allowed/refused":

1. **Service unavailable**: `available:false` with an `error` (`subagentModelSelection` not mounted or missing `current()`);
2. **Official `enabled:false`**: `available:true, enabled:false`, empty `routes`, **no** `error` (a normal state — the official list imposes no restriction);
3. **Official enabled but empty** (`current()` throws): `available:true`, `error` set, empty `routes`.

Reach for it when a new model will not work, a route is unexpectedly allowed, or you want to confirm the guard is really in effect.

## Known limitations

- External acp/SDK backends do not fire `agent/created` and expose no local provider/model; in that case the guard cannot determine the route and **allows and records** it (fail-open) rather than hard-refusing.
- Per-step auditing (`auditEveryStep`, default off) only writes logs and never blocks: reaching the model-call step means the creation-time check was bypassed, and refusing there would surface as "created successfully but fails immediately", so it only leaves a trace.
- The recent-denial records live only in process memory (`recentDenialLimit` defaults to 0) and are never persisted — a denial's reason contains a model name, which is private.
