# Disposable Gitea reliability fixture

This fixture pins the official Gitea Community Edition `1.27.0` container and
runs it only on localhost with SQLite and fictional data. It is a second genuine
HTTP application for private transfer testing; it is not a hosted customer
system.

The test bootstrap creates a local fictional administrator, two short-lived
personal access tokens with `write:issue` and `read:issue` scopes respectively,
and a disposable private repository. Token values are written only under the
gitignored `artifacts/` directory.

Upstream documentation:

- https://docs.gitea.com/installation/install-with-docker
- https://docs.gitea.com/development/api-usage
- https://docs.gitea.com/api/
