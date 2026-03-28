import { describe, test, expect } from "bun:test";
import { createLinearProvider } from "../src/providers/linear.ts";

describe("createLinearProvider", () => {
  test("filters ready issues by assignee and unblocked status", async () => {
    let receivedFilter: unknown;
    const provider = createLinearProvider({
      apiKey: "test-key",
      projectId: "proj-1",
      statuses: {
        ready: "Todo",
        in_progress: "In Progress",
        done: "Done",
        failed: "Canceled",
      },
      filters: {
        assignee_name: "Codex",
        assignee_is_app: true,
        unblocked_only: true,
      },
      client: {
        issues: async ({ filter }: { filter: unknown }) => {
          receivedFilter = filter;
          return {
            nodes: [
              {
                id: "issue-1",
                identifier: "ENG-100",
                title: "Test issue",
                description: "Body",
              },
            ],
          };
        },
        issue: async () => {
          throw new Error("not used");
        },
        team: async () => {
          throw new Error("not used");
        },
        updateIssue: async () => {
          throw new Error("not used");
        },
        createComment: async () => {
          throw new Error("not used");
        },
      },
    });

    const tickets = await provider.fetchReadyTickets();

    expect(receivedFilter).toEqual({
      project: { id: { eq: "proj-1" } },
      state: { name: { eq: "Todo" } },
      assignee: {
        name: { eq: "Codex" },
        app: { eq: true },
      },
      hasBlockedByRelations: { eq: false },
    });
    expect(tickets).toEqual([
      {
        id: "issue-1",
        identifier: "ENG-100",
        title: "Test issue",
        description: "Body",
      },
    ]);
  });

  test("omits assignee and blocker filters when not configured", async () => {
    let receivedFilter: unknown;
    const provider = createLinearProvider({
      apiKey: "test-key",
      projectId: "proj-1",
      statuses: {
        ready: "Todo",
        in_progress: "In Progress",
        done: "Done",
        failed: "Canceled",
      },
      filters: {
        unblocked_only: false,
      },
      client: {
        issues: async ({ filter }: { filter: unknown }) => {
          receivedFilter = filter;
          return { nodes: [] };
        },
        issue: async () => {
          throw new Error("not used");
        },
        team: async () => {
          throw new Error("not used");
        },
        updateIssue: async () => {
          throw new Error("not used");
        },
        createComment: async () => {
          throw new Error("not used");
        },
      },
    });

    await provider.fetchReadyTickets();

    expect(receivedFilter).toEqual({
      project: { id: { eq: "proj-1" } },
      state: { name: { eq: "Todo" } },
    });
  });
});
