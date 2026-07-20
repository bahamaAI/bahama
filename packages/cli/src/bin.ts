#!/usr/bin/env node
import { Command } from "commander";
import { runAuth, runSetup } from "./commands/auth-setup.js";
import { runConfig, runDetach, runDoctor, runInspect, runProviders, runStatus } from "./commands/info.js";
import { runInit } from "./commands/init.js";
import { runApply, runDeploy, runPlan } from "./commands/plan-apply.js";
import { fail, type EmitOptions } from "./runtime.js";

declare const __BAHAMA_VERSION__: string;

/**
 * The Bahama CLI. Model-facing design rules:
 * - every command emits one typed ResultEnvelope (JSON with --json);
 * - expected workflow states (auth_required, approval_required, …) exit 0;
 * - nothing ever waits on a TTY — missing input is a typed result.
 */
const program = new Command("bahama")
  .version(__BAHAMA_VERSION__)
  .description("Agent-native application infrastructure: declarative intent, deterministic plans, verified execution.");

const projectRoot = process.cwd();
const emitOptions = (cmd: { json?: boolean }): EmitOptions => ({ json: cmd.json === true });

const wrap =
  (name: string, action: (options: EmitOptions, ...args: string[]) => Promise<never>) =>
  async (...args: unknown[]) => {
    // commander passes (args..., options, command)
    const options = args.at(-2) as { json?: boolean };
    const positionals = args.slice(0, -2) as string[];
    const emitOpts = emitOptions(options ?? {});
    try {
      await action(emitOpts, ...positionals);
    } catch (error) {
      fail(name, emitOpts, error);
    }
  };

program
  .command("inspect")
  .description("Report non-secret application facts (framework, scripts, env var names) for provider selection")
  .option("--json", "emit a JSON result envelope")
  .action(wrap("inspect", (opts) => runInspect(projectRoot, opts)));

program
  .command("doctor")
  .description("Check the environment, manifest, and selected provider tools/sessions")
  .option("--json", "emit a JSON result envelope")
  .action(wrap("doctor", (opts) => runDoctor(projectRoot, opts)));

program
  .command("providers")
  .argument("[provider-id]", "show detailed guidance for one provider")
  .description("List provider capabilities; pass an id for use/avoid and setup guidance")
  .option("--format <format>", "agent (prose) or json", "agent")
  .option("--json", "emit a JSON result envelope")
  .action(async (providerId: string | undefined, options: { json?: boolean; format: string }) => {
    const emitOpts = { json: options.json === true || options.format === "json" };
    try {
      await runProviders(providerId, emitOpts.json ? "json" : "agent", emitOpts);
    } catch (error) {
      fail("providers", emitOpts, error);
    }
  });

program
  .command("init")
  .description("Write a starter bahama.yaml (never contacts providers, never creates a lock)")
  .requiredOption("--name <name>", "project name")
  .requiredOption("--application <provider>", "application provider id")
  .requiredOption("--framework <framework>", "application framework")
  .option("--database <provider>", "database provider id")
  .option("--json", "emit a JSON result envelope")
  .action(async (options: { json?: boolean; name: string; application: string; framework: string; database?: string }) => {
    const emitOpts = emitOptions(options);
    try {
      await runInit(
        projectRoot,
        {
          name: options.name,
          application: options.application,
          framework: options.framework,
          ...(options.database ? { database: options.database } : {}),
        },
        emitOpts,
      );
    } catch (error) {
      fail("init", emitOpts, error);
    }
  });

program
  .command("plan")
  .description("Validate bahama.yaml and compile a deterministic executable plan (read-only)")
  .option("--json", "emit a JSON result envelope")
  .action(wrap("plan", (opts) => runPlan(projectRoot, opts)));

program
  .command("apply")
  .argument("<plan-id>", "plan id from `bahama plan`")
  .description("Execute a compiled plan; consequential steps require --approved")
  .option("--approved", "confirm the user has reviewed the plan's consequential steps")
  .option("--json", "emit a JSON result envelope")
  .action(async (planId: string, options: { json?: boolean; approved?: boolean }) => {
    const emitOpts = emitOptions(options);
    try {
      await runApply(projectRoot, planId, { approved: options.approved === true }, emitOpts);
    } catch (error) {
      fail("apply", emitOpts, error);
    }
  });

program
  .command("deploy")
  .argument("[environment]", "environment to deploy (inferred when exactly one hosted environment exists)")
  .description("Fast path: compile and auto-apply when every step is routine; stop for approval otherwise")
  .option("--json", "emit a JSON result envelope")
  .action(wrap("deploy", (opts, environment) => runDeploy(projectRoot, environment, opts)));

program
  .command("detach")
  .description("Forget all resolved identities without deleting provider resources — for forks/templates only")
  .option("--approved", "confirm you intend to forget the entire resolved stack")
  .option("--json", "emit a JSON result envelope")
  .action(async (options: { json?: boolean; approved?: boolean }) => {
    const emitOpts = emitOptions(options);
    try {
      await runDetach(projectRoot, { approved: options.approved === true }, emitOpts);
    } catch (error) {
      fail("detach", emitOpts, error);
    }
  });

program
  .command("status")
  .description("Compare lock identity with live provider state and report drift")
  .option("--json", "emit a JSON result envelope")
  .action(wrap("status", (opts) => runStatus(projectRoot, opts)));

const auth = program.command("auth").description("Provider session management (delegates to official provider flows)");
for (const action of ["login", "status", "logout"] as const) {
  auth
    .command(action)
    .argument("<provider>", "provider id")
    .option("--no-browser", "never attempt a browser flow; print headless instructions")
    .option("--json", "emit a JSON result envelope")
    .action(async (provider: string, options: { json?: boolean; browser?: boolean }) => {
      const emitOpts = emitOptions(options);
      try {
        await runAuth(action, provider, { noBrowser: options.browser === false }, emitOpts);
      } catch (error) {
        fail("auth", emitOpts, error);
      }
    });
}

program
  .command("config")
  .argument("<action>", "path | get | set")
  .argument("[key]")
  .argument("[value]")
  .description("Non-secret global preferences (never tokens)")
  .option("--json", "emit a JSON result envelope")
  .action(async (action: string, key: string | undefined, value: string | undefined, options: { json?: boolean }) => {
    const emitOpts = emitOptions(options);
    try {
      if (action !== "path" && action !== "get" && action !== "set") {
        throw new Error(`Unknown config action \`${action}\`. Use path, get, or set.`);
      }
      await runConfig(action, key, value, emitOpts);
    } catch (error) {
      fail("config", emitOpts, error);
    }
  });

program
  .command("setup")
  .description("Verify the CLI installation and report host-integration guidance")
  .option("--host <host>", "auto | codex | claude-code | cursor | none", "auto")
  .option("--json", "emit a JSON result envelope")
  .action(async (options: { json?: boolean; host: string }) => {
    const emitOpts = emitOptions(options);
    try {
      await runSetup(options.host, __BAHAMA_VERSION__, emitOpts);
    } catch (error) {
      fail("setup", emitOpts, error);
    }
  });

program.parseAsync(process.argv).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(3);
});
