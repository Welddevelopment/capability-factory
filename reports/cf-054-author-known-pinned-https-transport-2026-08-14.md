# CF-054 author-known pinned-HTTPS transport checkpoint

Date: 2026-08-14  
Status: private author-known local development checkpoint; freeze awaiting final independent re-audit

## Result

Capability Factory now has a bounded customer-local HTTPS transport primitive that can carry
requests produced by the existing reviewed OpenAPI Binding Factory and Compiler to a real
loopback TLS endpoint. One joined fictional development fixture compiled an approved OpenAPI
write and read operation, resolved two separately scoped credential aliases in memory, wrote
one draft record over TLS, then read that record through the separate reviewed read route and
classified the business outcome as complete without using the action response as proof.

This is an author-known transport and compiler-join checkpoint. It is not a provider-transfer
campaign, real provider result, customer environment, or production deployment.

## Transport boundary

The transport:

- accepts only a credential-free loopback HTTPS base URL;
- validates the CA chain and hostname and additionally pins the exact leaf-certificate SHA-256;
- requires TLS 1.3 and opens a fresh connection for each request;
- deep-snapshots and validates its configuration before computing the implementation digest;
- deeply freezes exposed method and independence metadata;
- binds each request to an exact reviewed operation ID, method, path template and declaration digest;
- rejects raw encoded dot, slash, backslash and percent path forms;
- rejects redirects, caller-supplied authorization/cookie/hop-by-hop headers and credential-shaped line breaks;
- bounds URL, query, headers, JSON depth/nodes/keys/strings, body, response headers, response bytes and socket inactivity;
- rejects proxies, accessors, hidden fields, symbols, non-plain prototypes and `toJSON` hooks;
- enforces a bounded per-process in-memory request rate; and
- rejects a response that reflects the customer-local credential in a header or body.

Credential values are passed by the customer-local resolver at call time and exist transiently
in resolver and transport memory. The fixture proves that they are not persisted in the
provider state or serialized transport object; it does not prove memory secrecy or hardware-
backed credential isolation.

## Joined behavior

The author-known joined path used the existing product modules rather than a parallel test-only
compiler:

1. normalize explicitly approved local OpenAPI 3.1 material and confirm the exact TLS server;
2. compile reviewed target, credential aliases, read/write operations and authority candidate;
3. create digest-bound action and observer declarations from explicit mappings and outcome facts;
4. qualify the exact credential aliases and transport profiles for acceptance compilation;
5. compile the reviewed bindings;
6. require the trusted caller-provided exact grant before resolving the action credential;
7. serialize and send the reviewed write through the pinned transport;
8. resolve a separately scoped observer credential and send the reviewed read;
9. evaluate the documented result, duplicate, collateral and freshness paths; and
10. return `completed`, `resume`, zero incorrect side effects, and
   `actionResponseUsedAsProof: false`.

A missing grant stopped before a second write. This establishes that the joined compiler path
requires its current exact grant. It does not establish enforcement of every authority-wizard
limit, a signed external authority service, revocation after credential resolution, or an
immediate transport-level authority lease.

## Negative controls

The targeted suite rejects:

- changed certificate pin;
- redirect responses;
- oversized responses;
- socket inactivity timeout;
- non-JSON response content;
- caller-controlled authorization headers;
- wrong server, driver, method, operation, declaration or path;
- raw and encoded path traversal/separator forms;
- malformed query and credential values;
- hostile proxy/accessor/serialization-hook request data;
- post-construction mutation of methods, operations, credential alias, CA, pin and limits;
- mutation of exposed method and independence arrays; and
- a second request above an exact one-request test rate bound.

The negative controls preserve zero business writes when the rejected input precedes the one
allowed action, and exactly one write after the permitted action in the rate-limit case.

## Verification

Parent-run verification after the final repairs:

- targeted transport, joined path and adjacent existing compiler: 10 passed, 0 failed across
  3 files;
- TypeScript `--noEmit`: passed;
- `git diff --check`: passed;
- model/API calls and paid spend: zero;
- external network: zero; loopback TLS only.

## Exact claim boundary

Strongest current private wording:

> Capability Factory has an author-known local pinned-HTTPS transport primitive joined once to
> reviewed OpenAPI action and read-side bindings. The path performed one real loopback TLS write,
> separately authenticated read-side observation and outcome classification without treating the
> action response as proof.

Do not claim:

- observer process, implementation, service or failure-domain independence: the joined fixture
  uses one combined fictional provider process and common state;
- that the low-level transport enforces business authority or every wizard rule;
- real-provider SDK/HTTP transfer, customer evidence or broad OpenAPI compatibility;
- certificate rotation, remote-network, production TLS or service-discovery readiness;
- durable/distributed rate limiting: the current rate limit is per instance and resets on restart;
- an absolute wall-clock deadline: the current timeout is socket inactivity; or
- credential invisibility: values exist transiently in customer-local process memory.

The next prospective experiment must freeze this author-known transport and runner before a
separate party supplies materially different provider shapes. It must preserve unsupported
semantics as stops rather than modifying the transport after seeing held-out cases.
