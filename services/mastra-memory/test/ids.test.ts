import { describe, expect, it } from "vitest";

import { channelThreadId, projectResourceId } from "../src/ids.js";

describe("memory identifiers", () => {
  it("namespaces resources by community and project", () => {
    const first = projectResourceId({
      communityId: "wss://one.example",
      projectId: "30621:owner:project",
    });
    const otherCommunity = projectResourceId({
      communityId: "wss://two.example",
      projectId: "30621:owner:project",
    });
    const otherProject = projectResourceId({
      communityId: "wss://one.example",
      projectId: "30621:owner:other",
    });

    expect(first).not.toBe(otherCommunity);
    expect(first).not.toBe(otherProject);
    expect(first).toContain("30621%3Aowner%3Aproject");
  });

  it("maps each channel to a distinct thread inside its project", () => {
    const base = {
      communityId: "wss://one.example",
      projectId: "30621:owner:project",
    };

    expect(channelThreadId({ ...base, channelId: "frontend" })).not.toBe(
      channelThreadId({ ...base, channelId: "backend" }),
    );
  });
});
