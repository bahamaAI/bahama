import { describe, expect, it } from "vitest";
import type { ResultEnvelope } from "@bahama-ai/provider-kit";
import { renderHuman } from "../src/render.js";

describe("human rendering", () => {
  it("renders doctor checks and actionable auth requirements", () => {
    const envelope: ResultEnvelope = {
      protocolVersion: 1,
      command: "doctor",
      status: "auth_required",
      message: "2 check(s) need attention.",
      data: {
        checks: [
          { name: "node", ok: true, detail: "v22.18.0" },
          { name: "provider:neon", ok: false, detail: "neon auth" },
        ],
      },
      requirements: [
        {
          kind: "auth",
          providerId: "neon",
          loginHint: "bahama auth login neon",
          reason: "missing",
        },
      ],
      warnings: [],
    };

    const rendered = renderHuman(envelope);
    expect(rendered).toContain("ok node: v22.18.0");
    expect(rendered).toContain("failed provider:neon: neon auth");
    expect(rendered).toContain("Log in to neon (missing):  bahama auth login neon");
  });

  it("renders approval plans in execution order with clear approval framing", () => {
    const envelope: ResultEnvelope = {
      protocolVersion: 1,
      command: "deploy",
      status: "approval_required",
      message: "Plan plan_123 has 3 steps.",
      data: {
        planId: "plan_123",
        steps: [
          {
            id: "database-ensure",
            summary: "Verify the database still exists",
            classification: "routine",
          },
          {
            id: "application-ensure",
            summary: "Create the application",
            classification: "consequential",
            classificationReasons: ["creates a resource"],
          },
          {
            id: "application-deploy",
            summary: "Deploy the application",
            classification: "routine",
          },
        ],
      },
      warnings: [],
    };

    const rendered = renderHuman(envelope);
    expect(rendered).toContain("approval required Plan plan_123 has 3 steps.");
    expect(rendered).not.toContain("Review and approve the following plan");
    expect(rendered).toContain("Approve this plan with:\n    bahama apply plan_123 --approved");
    expect(rendered.indexOf("database-ensure")).toBeLessThan(rendered.indexOf("application-ensure"));
    expect(rendered.indexOf("application-ensure")).toBeLessThan(rendered.indexOf("application-deploy"));
  });
});
