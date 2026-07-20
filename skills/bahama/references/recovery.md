# Recovery

Bahama is designed to stop with a useful state instead of guessing. Read the complete result before deciding how to recover, and preserve every healthy locked resource you can.

## When planning cannot begin

`installation_required` means a selected provider tool is missing. Show the exact install instruction returned by Bahama, ask permission to install it, and retry.

`auth required` means the tool exists but its session is missing, expired, or wrong. Run `bahama auth login <provider>`, let the user complete the provider-owned flow, and retry.

`decision_required` usually means Bahama found a real choice it refuses to make silently, such as two Vercel accounts or several Neon organizations. Present every returned option, write the chosen value to the exact `writeBack` path in `bahama.yaml`, and make a new plan.

Status can also use `decision_required` for material drift. In that case there may be no write-back. Explain what changed remotely and establish the intended outcome before planning a repair.

Resource health is separate from command success: `not_ready` means expected setup is incomplete, `unhealthy` means a definite problem, and `unknown` means the provider could not assess it. Use the accompanying reason instead of inferring from `exists` alone.

## When a plan becomes stale

A plan approves a specific manifest, lock, provider configuration, account set, and sequence of operations. If one of those changes before apply, Bahama refuses to execute the old plan.

Do not edit or force the saved plan. Run `bahama plan` again and review the replacement. Neon also protects migration files with checksums, so changing approved SQL requires a new plan.

## When apply fails partway through

Read the failed step, message, and `data.recovery`. Fix the stated source or provider problem first.

If the apply never finished and its approved inputs are still valid, rerun the same apply command. Bahama skips steps it already verified and safely re-derives any secret value needed by a remaining step. If the error tells you to re-plan—or if the manifest, lock, migration, or provider configuration changed—make a fresh plan instead.

Deployment verification is the exception: if the provider accepted the deployment but readiness polling or the final live check failed, run `bahama status --json` before retrying. If production is already ready, do not rerun the apply; another attempt may publish a duplicate deployment.

A completed apply is not cached forever. Applying the same plan later is a fresh execution.

## When a remote resource is missing

Keep the lock and re-plan. If a Vercel project was deleted but the Neon database still exists, Bahama can plan a replacement Vercel project while continuing to address Neon by its locked ID.

Do not detach the whole stack to repair one missing resource.

Without a lock, providers can only adopt resources using their supported discovery rules, usually an exact name inside the selected account. Bahama deliberately does not make fuzzy guesses. A generated or renamed resource may be impossible to rediscover after its locked ID is lost.

## When the repository identity changes

The lock is tied to the repository so a copied template cannot silently deploy over the original project's infrastructure.

If this repository is an intentional new fork, `bahama detach` can make it a fresh stack. Explain the consequences and obtain approval first.

If the same project merely moved or changed remotes, do not detach. The current CLI can report a reconnect choice but does not yet complete that reconnect automatically. Stop and preserve the lock until that identity can be repaired safely.

## Detach and cleanup

`bahama detach --approved` removes the entire local `bahama.lock`. It does not delete or change any provider resource. The next plan may adopt exact-name matches or create new, potentially billable replacements. Generated or renamed resources may become orphaned from Bahama.

Use detach only when the user explicitly wants a fork or template to own a new stack—not as general troubleshooting.

Bahama currently has no destroy command. If the user asks to delete infrastructure, keep the lock while confirming the exact provider account and resource. Provider-dashboard or provider-CLI deletion is a separate destructive action and requires explicit authorization.

## Deployment failures

Use the selected host guide to understand its build and deployment contract. For Bahama Cloud, error codes distinguish packaging, dependency installation, build, publication, and readiness failures. For Vercel, verify the selected scope, framework, project identity, and provider configuration.

Read [bahama-cloud.md](bahama-cloud.md) or [vercel.md](vercel.md) for the selected host.

Set `BAHAMA_VERBOSE=1` only when additional diagnostics are needed. Redact provider output before sharing it in chat, issues, or test fixtures.
