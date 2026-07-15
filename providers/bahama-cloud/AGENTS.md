# Bahama Cloud provider guide

This file adds Bahama Cloud-specific rules to `providers/AGENTS.md`.

- The driver talks to the hosted control plane over REST using the CLI-injected renewable credential supplier. It never receives deployment-infrastructure credentials.
- Project and database provisioning must remain independent from source deployment.
- Source archives must preserve containment, size, and exclusion checks before signed upload.
- Deployment is asynchronous: upload, start the job, poll to a terminal state, then verify the published URL.
- Create development access only when declared local bindings require it; keep the token secret and server-side.
- Framework, deployment payload, or managed-resource changes require coordinated control-plane, deployer, descriptor, skill, and live-path review.

Verify with:

```bash
npx vitest run providers/bahama-cloud
npm run build -w @bahama/provider-bahama-cloud
```
