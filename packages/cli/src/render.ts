import type { JsonValue, PlannedStep, ResultEnvelope } from "@bahama-ai/provider-kit";

/**
 * Human rendering of the same typed envelope the JSON mode emits. Plain
 * text, no color codes: output is routinely read back by agents and pasted
 * into terminals we don't control.
 */
export function renderHuman(env: ResultEnvelope): string {
  const lines: string[] = [];
  lines.push(`${statusBadge(env.status)} ${env.message}`);

  const steps = env.data["steps"];
  if (Array.isArray(steps) && steps.length > 0) {
    lines.push("");
    for (const raw of steps) {
      const step = asStepLike(raw);
      if (!step) continue;
      const marker = step.classification === "consequential" ? "!" : "·";
      lines.push(`  ${marker} ${step.id}: ${step.summary}`);
      for (const reason of step.classificationReasons ?? []) {
        lines.push(`      ↳ ${reason}`);
      }
    }
  }

  const accounts = env.data["accounts"];
  if (accounts && typeof accounts === "object" && !Array.isArray(accounts) && Object.keys(accounts).length > 0) {
    lines.push("");
    lines.push("  Accounts:");
    for (const [provider, value] of Object.entries(accounts)) {
      const account = value as { id?: unknown; label?: unknown; kind?: unknown } | string;
      const text =
        typeof account === "object" && account !== null && typeof account.label === "string"
          ? `${account.label}${typeof account.kind === "string" ? ` (${account.kind})` : ""} — ${String(account.id)}`
          : String(value);
      lines.push(`    ${provider}: ${text}`);
    }
  }

  for (const requirement of env.requirements ?? []) {
    lines.push("");
    if (requirement.kind === "installation") {
      lines.push(`  Install ${requirement.tool}:  ${requirement.installHint}`);
    } else {
      lines.push(`  Log in to ${requirement.providerId} (${requirement.reason}):  ${requirement.loginHint}`);
    }
  }

  for (const decision of env.decisions ?? []) {
    lines.push("");
    lines.push(`  Decision needed: ${decision.question}`);
    for (const option of decision.options) {
      lines.push(`    - ${option.id}${option.description ? ` — ${option.description}` : ""}`);
    }
    if (decision.writeBack) {
      lines.push(`    Answer by setting \`${decision.writeBack}\` in bahama.yaml.`);
    }
  }

  for (const warning of env.warnings) {
    lines.push(`  warning: ${warning}`);
  }

  const planId = env.data["planId"];
  if (typeof planId === "string" && env.status === "approval_required") {
    lines.push("");
    lines.push(`  Review the steps above, then run: bahama apply ${planId} --approved`);
  }

  lines.push("");
  return lines.join("\n");
}

function statusBadge(status: ResultEnvelope["status"]): string {
  switch (status) {
    case "succeeded":
      return "ok";
    case "failed":
      return "failed";
    case "in_progress":
      return "in progress";
    default:
      return status.replace("_", " ");
  }
}

/** Steps arrive as JSON; render whatever quacks like a PlannedStep or StepSummary. */
function asStepLike(value: JsonValue): Pick<PlannedStep, "id" | "summary"> & Partial<PlannedStep> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const candidate = value as { id?: unknown; summary?: unknown };
  if (typeof candidate.id !== "string" || typeof candidate.summary !== "string") return null;
  return value as unknown as Pick<PlannedStep, "id" | "summary"> & Partial<PlannedStep>;
}
