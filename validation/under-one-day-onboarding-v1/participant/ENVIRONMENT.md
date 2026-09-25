# Environment

- Disposable local fixture only.
- Node 24 or the workspace-bundled Node runtime.
- Dependencies must come from the frozen lockfile/current checkout.
- Use a fresh state/output directory and random locally held test credentials.
- Bind local fixture traffic to `127.0.0.1` only.
- Evidence files must be mode `0600` where the platform supports it.
- Preserve exact tool versions, checkout commit, git diff, start/end timestamps, and command exit codes in the run manifest.
