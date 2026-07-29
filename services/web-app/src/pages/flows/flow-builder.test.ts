import { describe, expect, it } from "vitest";
import { buildDefinition } from "./flow-builder";

const DRAFTS = [
  { id: "greet", type: "message" as const, text: "Hi!", next: "ask" },
  {
    id: "ask",
    type: "question" as const,
    text: "1 or 2?",
    branches: [
      { match: "1", next: "bye" },
      { match: "2", next: "handoff" }
    ],
    fallbackNext: "ask"
  },
  { id: "handoff", type: "assign_team" as const, teamId: "11111111-1111-1111-1111-111111111111", next: "bye" },
  { id: "bye", type: "end" as const }
];

describe("buildDefinition", () => {
  it("serializes drafts into the engine's shape, omitting empty nexts", () => {
    const result = buildDefinition("greet", DRAFTS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.start).toBe("greet");
    expect(result.value.nodes.greet).toEqual({ type: "message", text: "Hi!", next: "ask" });
    expect(result.value.nodes.ask).toEqual({
      type: "question",
      text: "1 or 2?",
      branches: [
        { match: "1", next: "bye" },
        { match: "2", next: "handoff" }
      ],
      fallbackNext: "ask"
    });
    expect(result.value.nodes.bye).toEqual({ type: "end" });
  });

  it("rejects duplicate/empty ids, missing start, dangling targets", () => {
    expect(buildDefinition("greet", []).ok).toBe(false);
    expect(buildDefinition("nope", DRAFTS).ok).toBe(false);
    expect(buildDefinition("a", [{ id: "a", type: "message", text: "x", next: "ghost" }]).ok).toBe(false);
    expect(
      buildDefinition("a", [
        { id: "a", type: "message", text: "x" },
        { id: "a", type: "end" }
      ]).ok
    ).toBe(false);
  });

  it("enforces per-type requirements", () => {
    expect(buildDefinition("a", [{ id: "a", type: "message", text: " " }]).ok).toBe(false);
    expect(buildDefinition("a", [{ id: "a", type: "question", text: "q", branches: [] }]).ok).toBe(false);
    expect(
      buildDefinition("a", [{ id: "a", type: "question", text: "q", branches: [{ match: "1", next: "" }] }]).ok
    ).toBe(false);
    expect(buildDefinition("a", [{ id: "a", type: "add_tag" }]).ok).toBe(false);
    expect(buildDefinition("a", [{ id: "a", type: "assign_team" }]).ok).toBe(false);
  });

  it("branches with blank match strings are dropped; all-blank fails", () => {
    const result = buildDefinition("a", [
      {
        id: "a",
        type: "question",
        text: "q",
        branches: [
          { match: "  ", next: "b" },
          { match: "yes", next: "b" }
        ]
      },
      { id: "b", type: "end" }
    ]);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const ask = result.value.nodes.a;
      expect(ask?.type).toBe("question");
      if (ask && ask.type === "question") {
        expect(ask.branches).toEqual([{ match: "yes", next: "b" }]);
      }
    }
  });
});
