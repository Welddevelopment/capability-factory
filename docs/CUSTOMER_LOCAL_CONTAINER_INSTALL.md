# Customer-local container installation

Status: **controlled-pilot packaging reference; not a published production image**

This package runs the durable sidecar and customer adapter on customer-controlled infrastructure. It does not create a Capability Factory cloud control plane. Credentials stay in the customer-local package as private files and runtime aliases; they are never baked into the image or release manifest.

## Boundary

- Docker publishes the sidecar only on host `127.0.0.1`.
- The process listens on `0.0.0.0` *inside* the isolated container solely so that Docker's localhost port mapping works. The CLI refuses this mode unless `CF_CONTAINER_LOCALHOST_PUBLISH=acknowledged` is present.
- Do not replace the Compose port with `4317:4317`, use host networking, or expose it through a reverse proxy during a controlled pilot.
- The container is non-root, read-only except for its mounted state directory, drops Linux capabilities, uses `no-new-privileges`, and limits process count.
- The customer must still approve the adapter, target systems, credentials, scopes, model/provider boundary, retention and incident process before activation.

## Build and initialize

For repository development, copy `packaging/pilot/compose.example.yml` into a private installation directory as `compose.yml`. For a release rehearsal or customer-controlled installation, use `packaging/pilot/compose.release.example.yml` and set `CF_IMAGE_REF` to an immutable `image@sha256:...` reference; that file has no repository build dependency. Place the reviewed adapter runtime beside it as `runtime.mjs`, and create a writable `pilot-state` directory owned by the chosen `CF_UID`/`CF_GID`.

Set non-secret identifiers in the shell:

```sh
export CF_INSTALLATION_ID=customer-pilot-001
export CF_TENANT_ID=customer_tenant
export CF_PRODUCT_VERSION=0.1.0
export CF_IMAGE_REF=registry.example/capability-factory/pilot@sha256:replace-with-verified-digest
export CF_UID=$(id -u)
export CF_GID=$(id -g)
docker compose --profile setup run --rm setup
docker compose up -d sidecar
docker compose ps
```

The initialization output names the private access-token and continuation-secret files. Read them only from the customer machine; do not paste their contents into tickets, chat, source control or release metadata.

## Integrity and signing

`pilot:release` creates a byte-level manifest for an explicit allowlist of build inputs. It rejects traversal, symlinks, private workspace folders, `.env` files and secret-shaped filenames. A release operator may create an Ed25519 key outside the repository, sign the canonical manifest, and provide the public key and detached signature to the customer.

```sh
pnpm pilot:release manifest --root . --version 0.1.0 --output /private/path/release.json --container-context --image-digest sha256:replace-with-exact-image-digest
pnpm pilot:release keygen --private /private/path/release-private.pem --public /private/path/release-public.pem
pnpm pilot:release sign --manifest /private/path/release.json --private /private/path/release-private.pem --signature /private/path/release.sig
pnpm pilot:release verify --root . --manifest /private/path/release.json --public /private/path/release-public.pem --signature /private/path/release.sig
```

This proves that supplied bytes match a locally trusted key. It does **not** claim a production release authority, public registry provenance, independent audit, vulnerability-free image or formal software-supply-chain certification.

If a final image is pushed to a customer-approved private registry, recreate the manifest with the immutable `sha256:...` image digest. Never deploy by a mutable tag alone.

## Upgrade and rollback

1. Halt or drain new work through the customer-local runtime controls.
2. Export sanitized pilot evidence and take the package's verified backup.
3. Verify the next input manifest, signature and immutable image digest.
4. Run readiness and adapter acceptance against disposable state before switching.
5. Start the new version and reconcile every in-flight write before retry.
6. If readiness or reconciliation fails, restore the verified backup and the previous image digest. Do not blindly restart writes.

The explicit customer-local rollback command is:

```sh
pnpm pilot:lifecycle restore --root /customer/path/pilot-state --backup <verified-backup-id>
```

The existing lifecycle package supplies backup, restore, upgrade and rollback mechanics. The container does not turn those controls into an automatic unattended production updater.

## Doctor and support bundle

Run the package-specific doctor before startup and after any filesystem, secret, adapter or
version change:

```sh
pnpm pilot:package doctor --root /customer/path/pilot-state
```

Each failed check gives a safe next action. A failed doctor blocks activation. For support,
export a new immutable sanitized bundle rather than copying databases, logs or secret files:

```sh
pnpm pilot:package support --root /customer/path/pilot-state --output /customer/private/support-2026-07-30.json
```

The bundle contains lifecycle, pinned adapter hash, limits, readiness and storage posture. It
contains neither secret values nor customer payloads. It still may contain customer-chosen
identifiers, so the customer controls where it is shared.

## Uninstall

Stop the sidecar, export the final sanitized evidence, run the documented lifecycle uninstall/archive procedure, and have the customer decide whether to retain or delete the private state directory under the agreed retention policy. Container deletion alone is not evidence that mounted customer data was removed.
