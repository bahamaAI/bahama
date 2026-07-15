import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import type { CapabilityAddress, JsonObject, JsonValue } from "@bahama-ai/provider-kit";
import { hashJson } from "./hash.js";

export const MANIFEST_FILENAME = "bahama.yaml";

/**
 * Keys and value shapes that mean someone put RESOLVED PROVIDER IDENTITY in
 * the intent file. Resource IDs live in bahama.lock — a model that sees
 * `projectId:` in a manifest example will fabricate plausible IDs in the
 * next manifest it writes, and the CLI would read that as an adoption
 * request for a resource that doesn't exist (or isn't yours).
 */
const ID_SHAPED_KEYS = new Set([
  "projectid",
  "accountid",
  "orgid",
  "organizationid",
  "teamid",
  "resourceid",
  "deploymentid",
]);

const nameSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, "use lowercase letters, digits, and hyphens");

const configSchema: z.ZodType<JsonObject> = z.record(z.string(), z.custom<JsonValue>());

// Structural levels are STRICT: the manifest is agent-authored intent, and a
// typo'd key that silently validates as "not there" is exactly how an agent's
// intended binding or resource quietly never happens. `config` blocks stay
// open — providers validate those with their own intentSchema.
const legacyApplicationSchema = z
  .object({
    provider: z.string().min(1),
    framework: z.string().min(1),
    config: configSchema.optional(),
  })
  .strict();

const resourceSchema = z
  .object({
    provider: z.string().min(1),
    engine: z.string().optional(),
    environment: z.string().regex(/^[a-z0-9-]+$/).optional(),
    config: configSchema.optional(),
  })
  .strict();

const applicationSchema = z
  .object({
    framework: z.string().min(1),
    dir: z.string().min(1).optional(),
  })
  .strict();

const environmentSchema = z
  .object({
    provider: z.string().min(1),
    config: configSchema.optional(),
  })
  .strict();

const addressPattern = /^(application|resources\.[a-z0-9-]+|environments\.[a-z0-9-]+)\.[a-zA-Z][a-zA-Z0-9]*$/;

const bindingSchema = z
  .object({
    from: z.string().regex(addressPattern, {
      message: "expected `resources.<key>.<capability>` or `environments.<name>.<capability>`",
    }),
    to: z.union([z.string().regex(addressPattern), z.array(z.string().regex(addressPattern)).min(1)]),
  })
  .strict();

const environmentManifestSchema = z
  .object({
    version: z.literal(1),
    project: z.object({ name: nameSchema }).strict(),
    application: applicationSchema.optional(),
    environments: z.record(z.string().regex(/^[a-z0-9-]+$/), environmentSchema).default({}),
    resources: z.record(z.string().regex(/^[a-z0-9-]+$/), resourceSchema).default({}),
    bindings: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), bindingSchema).default({}),
  })
  .strict();

const legacyManifestSchema = z
  .object({
    version: z.literal(1),
    project: z.object({ name: nameSchema }).strict(),
    application: legacyApplicationSchema,
    resources: z.record(z.string().regex(/^[a-z0-9-]+$/), resourceSchema).default({}),
    bindings: z.record(z.string().regex(/^[A-Z][A-Z0-9_]*$/), bindingSchema).default({}),
  })
  .strict();

export interface Manifest {
  version: 1;
  project: { name: string };
  application?: { framework: string; dir?: string | undefined } | undefined;
  environments: Record<string, { provider: string; config?: JsonObject | undefined }>;
  resources: Record<string, { provider: string; engine?: string | undefined; environment?: string | undefined; config?: JsonObject | undefined }>;
  bindings: Record<string, { from: string; to: string | string[] }>;
  /** Internal compatibility marker; never accepted as a manifest key. */
  legacyApplication?: { provider: string; config?: JsonObject | undefined } | undefined;
}

export const manifestSchema = z.union([environmentManifestSchema, legacyManifestSchema]).transform((value): Manifest => {
  if ("environments" in value) return value as Manifest;
  const config = { ...(value.application.config ?? {}) };
  return {
    version: 1,
    project: value.project,
    application: { framework: value.application.framework },
    environments: { production: { provider: value.application.provider, ...(Object.keys(config).length ? { config } : {}) } },
    resources: value.resources,
    bindings: value.bindings,
    legacyApplication: { provider: value.application.provider, ...(Object.keys(config).length ? { config } : {}) },
  };
}) as z.ZodType<Manifest, z.ZodTypeDef, unknown>;

export class ManifestError extends Error {
  constructor(
    message: string,
    readonly issues: string[] = [],
  ) {
    super(message);
    this.name = "ManifestError";
  }
}

export function parseCapabilityAddress(raw: string): CapabilityAddress {
  const parts = raw.split(".");
  if (parts[0] === "application" && parts.length === 2) {
    return { resourceKey: "application", capability: parts[1]! };
  }
  if (parts[0] === "environments" && parts.length === 3) {
    return { resourceKey: `environment.${parts[1]!}`, capability: parts[2]! };
  }
  if (parts[0] === "resources" && parts.length === 3) {
    return { resourceKey: parts[1]!, capability: parts[2]! };
  }
  throw new ManifestError(`Invalid capability address: ${raw}`);
}

function findIdShapedKeys(value: unknown, path: string, hits: string[]): void {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => findIdShapedKeys(entry, `${path}[${index}]`, hits));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, entry] of Object.entries(value)) {
      const childPath = path ? `${path}.${key}` : key;
      if (ID_SHAPED_KEYS.has(key.toLowerCase())) hits.push(childPath);
      findIdShapedKeys(entry, childPath, hits);
    }
  }
}

export function validateManifest(raw: unknown): Manifest {
  const parsed = manifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`);
    // The issues ride in the message too: agents see only the message text.
    throw new ManifestError(`bahama.yaml is invalid — ${issues.join("; ")}`, issues);
  }

  const idHits: string[] = [];
  findIdShapedKeys(raw, "", idHits);
  if (idHits.length > 0) {
    throw new ManifestError(
      `bahama.yaml contains resolved identity fields (${idHits.join(", ")}). ` +
        `Resource IDs live in bahama.lock and are resolved by \`bahama plan\` — remove them from the manifest.`,
    );
  }

  // Binding endpoints must reference resources that exist in this manifest.
  if (!parsed.data.application && Object.keys(parsed.data.environments).length > 0) {
    throw new ManifestError("bahama.yaml defines environments but no application framework.");
  }
  for (const [name, binding] of Object.entries(parsed.data.bindings)) {
    const destinations = Array.isArray(binding.to) ? binding.to : [binding.to];
    for (const endpoint of [binding.from, ...destinations]) {
      const address = parseCapabilityAddress(endpoint);
      const environmentName = address.resourceKey.startsWith("environment.") ? address.resourceKey.slice(12) : null;
      if (address.resourceKey === "application" && !parsed.data.legacyApplication) {
        throw new ManifestError(
          `Binding ${name} uses legacy address \`${endpoint}\`. Use \`environments.<name>.<capability>\` in the environment-based manifest.`,
        );
      }
      if (environmentName && !(environmentName in parsed.data.environments)) {
        throw new ManifestError(`Binding ${name} references \`${endpoint}\`, but \`environments.${environmentName}\` is not defined.`);
      }
      if (!environmentName && address.resourceKey !== "application" && !(address.resourceKey in parsed.data.resources)) {
        throw new ManifestError(
          `Binding ${name} references \`${endpoint}\`, but \`resources.${address.resourceKey}\` is not defined.`,
        );
      }
    }
  }

  for (const [name, resource] of Object.entries(parsed.data.resources)) {
    if (resource.environment && !(resource.environment in parsed.data.environments)) {
      throw new ManifestError(`Resource ${name} targets environment \`${resource.environment}\`, but that environment is not defined.`);
    }
    if (resource.environment && parsed.data.environments[resource.environment]?.provider !== resource.provider) {
      throw new ManifestError(
        `Resource ${name} is native to provider \`${resource.provider}\`, but environment \`${resource.environment}\` uses ` +
          `\`${parsed.data.environments[resource.environment]?.provider}\`. Remove environment or choose a matching native environment.`,
      );
    }
  }

  return parsed.data;
}

export async function loadManifest(projectRoot: string): Promise<Manifest> {
  const path = join(projectRoot, MANIFEST_FILENAME);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    throw new ManifestError(
      `No ${MANIFEST_FILENAME} found in ${projectRoot}. Run \`bahama init\` to create one.`,
    );
  }
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (error) {
    throw new ManifestError(
      `${MANIFEST_FILENAME} is not valid YAML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return validateManifest(raw);
}

/** Hash of the validated manifest — the "intent hash" side of plan validity. */
export function manifestHash(manifest: Manifest): string {
  return hashJson(manifest as unknown as JsonValue);
}
