# Authenticated signed-message ingress checkpoint — 2026-07-31

## Result

The existing experimental inbox capability can now begin from a real loopback
customer-local webhook rather than only from a repository-seeded message file.
A correctly signed, fresh, bounded plaintext order earns a durable trusted-ingress
receipt and then enters the existing acquire → verify → act → verify outcome →
resume → retain loop through the shared customer-local capability-mode sidecar.
The webhook route is registered on that same loopback sidecar application and
origin rather than creating a second customer-facing product boundary.

This is one bounded signed-message entrance, not provider-specific messaging support.

## Causal path

1. A fictional supplier sends one raw `message/rfc822` body to an exact localhost
   route.
2. The receiver requires a bounded delivery ID, exact `.eml` alias, timestamp,
   content SHA-256 and HMAC-SHA256 signature.
3. The HMAC key is resolved only at the customer-local boundary from a mode-0600
   secret file with exact target/action/method scope.
4. Invalid signatures, changed bytes and stale timestamps stop before inbox
   acceptance.
5. A successful delivery is promoted into the approved inbox with an exclusive
   create operation and recorded in a customer-local SQLite receipt store.
6. The inbox capability driver independently reads that durable receipt. A file
   without the matching receipt remains ineligible.
7. The existing bounded capability is built and probed before first use, creates
   exactly one draft under the exact approval, independently verifies the draft
   store, resumes the original goal, retains the capability and reuses it on the
   next signed message.

## Replay, concurrency and restart behavior

- An accepted delivery ID or input alias cannot be accepted again.
- Two simultaneous correctly signed deliveries for the same input alias produce
  one acceptance and one conflict; the loser cannot overwrite or delete the
  accepted message.
- Atomic hard-link promotion is used instead of POSIX rename because rename could
  replace an existing file.
- The trusted-ingress receipt survives a fresh process and remains available to
  the capability driver after restart.
- The receipt contains message identity, content digest, customer-local secret
  version and receipt time; it does not contain the signing secret.

## Customer-local package and sidecar

The signed ingress uses the same additive experimental-mode package as the browser,
file/EDI, inbox and document drivers:

- the package pins the reviewed contract;
- the HMAC verification key is declared by alias and stored only in the private
  customer-local secret directory;
- the package readiness gate fails when that credential is absent or unsafe;
- the durable capability-mode sidecar receives the explicit
  `experimental-inbox-message-actions` envelope;
- the signed webhook and authenticated job API share the same customer-local
  loopback sidecar origin while retaining different authentication rules;
- the sidecar request now accepts the exact safe `.eml` alias used by the driver;
- the mode remains separately labelled `experimental-local`; and
- its claim boundary explicitly says signed customer-local webhook or local
  trusted ingress, not a general messaging/email agent.

## Runnable local demonstration

With localhost binding permitted:

```text
pnpm demo:inbox-message:signed
```

The demonstration performs one signed fictional delivery, capability build,
pre-use probe, one permission-bound draft action, independent draft-store
verification, original-goal resumption, and exact replay rejection.

## Validation

- Strict TypeScript check passed.
- Focused signed-ingress, inbox driver/loop, shared sidecar and package regression:
  5 files, 21 tests passed.
- Complete ordinary regression: 59 files and 298 tests passed; 11 files and 59
  environment-gated tests remained intentionally skipped.
- The runnable signed-message demo completed and returned an exact replay conflict.
- The first focused attempt inside the restricted execution sandbox failed only
  because localhost binding returned `EPERM`; the identical tests passed when
  localhost binding was permitted.

## GTM implication

This removes the narrow product blocker “the inbox experiment only begins from a
locally seeded file.” It gives discovery conversations involving customer-owned
webhook/message entrances a real bounded local proof and reuses the shared package
and sidecar architecture.

It does **not** automatically reclassify all messaging/voice prospects as pilot
eligible. Provider-specific WhatsApp, SMS, email, voice and inbox access may still
require external accounts, consent, opt-out handling, attachments, identity,
regulated-data controls, platform approval or a different message contract. The
GTM ledger should reassess companies individually rather than treating this
checkpoint as a blanket unlock.

## Evidence boundary and remaining blockers

This is local fictional evidence. It does not establish:

- Gmail, Microsoft 365, IMAP, WhatsApp, SMS, voice or other provider integration;
- arbitrary messages, attachments, HTML, MIME trees or document understanding;
- sender enrollment, consent, unsubscribe or channel compliance;
- public-internet ingress, TLS termination, firewall compatibility, rate limiting
  under hostile traffic or denial-of-service resistance;
- customer deployment, production reliability or external security review; or
- a formal final green verdict.

Product work still cannot remove blockers requiring a real customer workflow and
credentials, provider or enterprise approval, legal authority, regulated-data
review, buyer demand, willingness to pay, procurement, or production operations.
