import type { JsonObject } from "./json.js";

/**
 * The normalized outcome vocabulary shared by every Bahama command and step.
 * These are expected workflow states, not exceptions: a missing login is a
 * typed `auth_required`, never an interactive hang.
 */
export const COMMAND_STATUSES = [
  "succeeded",
  "decision_required",
  "installation_required",
  "auth_required",
  "approval_required",
  "in_progress",
  "failed",
] as const;

export type CommandStatus = (typeof COMMAND_STATUSES)[number];

/** A provider tool that must be installed before Bahama can proceed. */
export interface InstallationRequirement {
  kind: "installation";
  providerId: string;
  tool: string;
  /** Copy-pasteable install command, e.g. `npm i -g vercel`. */
  installHint: string;
  detail?: string;
}

/** A provider session that must be established or repaired by the user. */
export interface AuthRequirement {
  kind: "auth";
  providerId: string;
  /**
   * The command the HUMAN should run in their own terminal, e.g.
   * `bahama auth login vercel`. Agents surface this; they do not run
   * interactive logins themselves.
   */
  loginHint: string;
  reason: "missing" | "expired" | "mismatch";
  detail?: string;
}

export type Requirement = InstallationRequirement | AuthRequirement;

/** One selectable option inside a Decision. */
export interface DecisionOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * A meaningful choice the CLI refuses to infer (e.g. which of two Vercel
 * teams). The model/user answers by writing the choice back into intent —
 * `writeBack` names the manifest path that resolves it.
 */
export interface Decision {
  kind: "decision";
  id: string;
  providerId?: string;
  question: string;
  options: DecisionOption[];
  /** Manifest path whose value resolves this decision, e.g. `resources.database.config.orgId`. */
  writeBack?: string;
}

/**
 * The single JSON envelope every CLI command writes to stdout in --json mode.
 * Human rendering consumes the same object; the two outputs can never drift.
 */
export interface ResultEnvelope<T extends JsonObject = JsonObject> {
  protocolVersion: 1;
  command: string;
  status: CommandStatus;
  message: string;
  data: T;
  requirements?: Requirement[];
  decisions?: Decision[];
  warnings: string[];
}
