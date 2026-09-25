# Capability Factory Console — private alpha product specification

Status: local product reference. This is not a production service or reliability claim.

## People and journeys

### Customer operator

The operator opens Runs, scans outcome and intervention state, then opens the inspector to
follow one immutable causal history: goal, diagnosis, search decision, authority,
verification, execution, direct outcome evidence, resumption, and retention. If the run
stops safely, the operator follows its linked handoff. They can acknowledge a handoff but
cannot edit a run or declare an outcome successful.

### Customer engineer

The engineer inspects retained capabilities and their verification receipts, origin,
documentation version, actions, and usage history. They can quarantine or revoke through
an adapter to the authoritative capability store. They inspect environment health and run
acceptance tests without retrieving secret values. Verified manifests are read-only.

### Customer administrator / security user

The administrator creates a narrow versioned policy draft, validates it, reviews its
readable authority preview, runs a sandbox acceptance test, and only then activates it.
Prior versions remain visible. They can supply an explicitly supported approval to a
handoff, creating a linked continuation rather than rewriting history.

One person may perform all three jobs in this local alpha; the navigation retains the job
boundaries so pilot packaging can change without changing product semantics.

## Route map and acceptance criteria

| Route | Job | Acceptance criteria |
|---|---|---|
| `/runs` | Operations | Tenant-scoped list; recorded runs are unmistakable; inspector renders the full causal loop and receipt evidence from one event renderer. |
| `/runs/:runId` | Operations | Deep-linkable inspector; immutable original goal and run source; safe reconnect/empty/error states. |
| `/handoffs` | Operations | Actual envelopes, reason and missing authority; lifecycle changes append events; resolution creates a linked continuation. |
| `/capabilities` | Capability control | Authoritative adapter projection; active/quarantined/revoked filters; receipts and related runs; no manifest editor. |
| `/environments` | Capability control | Mode, runner/verifier health, aliases and acceptance state; secret values never appear. Setup lives here. |
| `/policies` | Capability control | Versioned draft → validation → preview → acceptance test → activation; untested drafts cannot activate. |
| `/playground` | Developer tools | Explicit simulator framing; ordinary-goal input; uses the same event ingestion and run renderer as SDK/sidecar/recorded paths. |

## Safe command set

- Quarantine or revoke through the capability authority adapter.
- Acknowledge a handoff; supply approval only for an approval handoff.
- Create and validate a policy draft; test it; activate only the tested unchanged version.
- Run an environment acceptance test.
- Start a deterministic Agent Playground run.

There is no command to edit a verified manifest, override an outcome, change a run status,
blindly retry an ambiguous write, cancel with an implication of no side effect, or restore
a quarantined capability without reverification.

## Evidence language

The console uses “Private alpha” and “local product reference.” The recorded fixture is
labelled “Recorded run” and “Constrained local run · fictional data · genuine disposable
ERPNext installation.” It makes no customer, production, generality, or formal-verdict
claim.

## Bounded reference goal coordinator

The Agent Playground can accept one broad fictional order-operations goal and invoke a
constrained deterministic coordinator. This is an integration simulator, not a general
autonomous planner. A customer's existing agent may instead decompose its own goal and
call Capability Factory for each blocked work item.

The parent run preserves the separation between planning and acquisition:

- the reference coordinator proposes smaller jobs and conservative dependencies;
- trusted fixture code validates entities, documented operations, deadline, dependency
  graph, authority non-expansion, and completion criteria before activation;
- each work item links to its own underlying Capability Factory run;
- Capability Factory handles only the capability gap, authority, verification, execution,
  external outcome, resumption, retention, or handoff for that item; and
- a separate aggregate verifier decides whether the broad goal is complete.

The parent inspector shows trusted scope, plan lifecycle, grouping reasons, stable order,
dependencies, per-item acquisition path, direct receipts, handoffs, and an explicit
complete/partially-complete/blocked/unknown roll-up. A blocked item never disappears into
an overall success. Independent work may continue only because the fixture's trusted
dependency graph declares it independent.
