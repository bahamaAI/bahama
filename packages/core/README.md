# @bahama-ai/core

Bahama's internal engine: manifest and lock handling, deterministic plan
compilation, routine/consequential classification, the apply executor with
postcondition verification and resume, the journal, and the sealed-secret
plumbing (redactor, broker, safe subprocess runner).

**This package is published only because the Bahama CLI depends on it at
runtime.** It is not a supported public API and carries no compatibility
guarantees between versions — the CLI pins it exactly. If you are building a
Bahama provider, the supported surface is
[`@bahama-ai/provider-kit`](https://www.npmjs.com/package/@bahama-ai/provider-kit);
if you want the tool, install [`@bahama-ai/cli`](https://www.npmjs.com/package/@bahama-ai/cli).
