# Genuine local ERPNext sandbox

Status: **private disposable development environment — not customer evidence**

The local stack uses official Frappe Docker configuration with Frappe 16.28.0, ERPNext
16.29.0, MariaDB 11.8, and Redis 6.2 inside a Colima virtual machine. It listens only on
localhost and contains fictional records and deterministic local credentials.

The adapter is `src/customer-world/real-erpnext-world.ts`. The idempotent seed, reset, and
direct-verifier module is `scripts/erpnext/seed_real_world.py`. The pinned Compose fixture
lives at `fixtures/erpnext/compose.yml`; generated results remain under ignored `artifacts/`,
and local container tools remain under ignored `.local-tools/`.

The containers and Colima virtual machine were stopped after the overnight work to release
CPU and memory. Their data was not deleted. Restart the `capability-factory` Colima profile
with the project-local Lima tools on `PATH`, then run `pnpm pilot:erpnext:up` before the
real suite. This is intentionally a development-only manual step; no background service
is installed.

Run the six-case integration suite only while the disposable stack is healthy:

```sh
pnpm sandbox:real:test
```

The two real-system test files must run serially because both deliberately reset the same
disposable ERPNext site. The package command disables file parallelism. A preserved
concurrent combined attempt produced 6/7 before this orchestration error was corrected;
do not hide or misclassify that harness-isolation failure as a product failure.

The suite checks:

- stable reset plus already-satisfied state;
- genuine REST resource GET, POST, and PUT behavior;
- retained manifest reuse from a fresh registry process;
- read-only and deliberately incomplete roles failing before a business write;
- missing required target data producing safe no-action; and
- read-before-retry reconciliation after a simulated lost response, with exactly one
  Delivery Note.

A seventh opt-in product-path check runs the shared SDK/coordinator against the genuine
application: it builds once, completes and directly verifies one real-system case, then a
fresh SDK/coordinator process reuses the retained capability on another order. This remains
deterministic and model-free.

The first integration attempt correctly failed because the custom role could not read a
linked ERPNext Account. The fixed role grants read/select access to the exact linked master
records required by the workflow, while restricted profiles still cannot create the
Delivery Note. Preserve this as a transfer lesson: application-level permissions are more
complex than endpoint-level HTTP authorization.

Never expose the synthetic tokens, publish the stack, add production data, or present the
six passing cases as model autonomy, a held-out customer test, or production reliability.

See `PRODUCT_MODEL_TRANSFER_REPORT.md` for the later model-backed product development
chronology. That run begins after diagnosis and remains non-held-out, synthetic, private,
and separate from the absence of a formal final green verdict.
