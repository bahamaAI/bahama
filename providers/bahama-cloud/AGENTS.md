# Bahama Cloud provider guide

This file adds Bahama Cloud-specific rules to `providers/AGENTS.md`.

- The driver talks to the hosted control plane over REST using the CLI-injected renewable credential supplier. It never receives deployment-infrastructure credentials.
- Project and database provisioning must remain independent from source deployment.
- Source archives must preserve containment, size, and exclusion checks before signed upload.
- Deployment is asynchronous: the mutating package/upload/start step produces
  the durable job ID, a separate read-only step consumes that ID while polling,
  and a final step verifies the published URL.
- Create development access only when declared local bindings require it; keep the token secret and server-side.
- The control-plane-to-deployer job contract is versioned and strictly
  validated in the private Cloud repositories. Framework, payload, or
  managed-resource changes require coordinated contract fixtures, control
  plane, deployer, descriptor, skill, documentation, and live-path review.
  Roll out a compatible receiver before a producer sends a new shape.

Verify with:

```bash
npx vitest run providers/bahama-cloud
npm run build -w @bahama/provider-bahama-cloud
```
