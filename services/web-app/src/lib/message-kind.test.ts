import { describe, expect, it } from "vitest";
import {
  contactCardsOf,
  interactivePromptOf,
  interactiveReplyOf,
  locationOf,
  mapsUrl,
  messageKind,
  placeholderCount,
  safeHttpUrl,
  substituteTemplate,
  templateOf
} from "./message-kind";

describe("messageKind", () => {
  it("prefers outbound payload.kind", () => {
    expect(messageKind({ payload: { kind: "location" } })).toBe("location");
  });

  it("falls back to inbound Meta payload.type", () => {
    expect(messageKind({ payload: { type: "image" } })).toBe("image");
  });

  it("prefers kind over type when both present", () => {
    expect(messageKind({ payload: { kind: "template", type: "text" } })).toBe("template");
  });

  it("defaults to text when neither is present or usable", () => {
    expect(messageKind({ payload: {} })).toBe("text");
    expect(messageKind({ payload: { kind: 42, type: "" } })).toBe("text");
  });
});

describe("locationOf", () => {
  it("returns coords when both are finite numbers", () => {
    expect(locationOf({ location: { latitude: 12.9716, longitude: 77.5946, name: "HQ", address: "MG Rd" } })).toEqual({
      latitude: 12.9716,
      longitude: 77.5946,
      name: "HQ",
      address: "MG Rd"
    });
  });

  it("accepts numeric strings (inbound coords)", () => {
    expect(locationOf({ location: { latitude: "1.5", longitude: "2.5" } })).toEqual({
      latitude: 1.5,
      longitude: 2.5,
      name: undefined,
      address: undefined
    });
  });

  it("returns undefined when a coordinate is missing or non-numeric", () => {
    expect(locationOf({ location: { longitude: 10 } })).toBeUndefined();
    expect(locationOf({ location: { latitude: "abc", longitude: 10 } })).toBeUndefined();
    expect(locationOf({})).toBeUndefined();
  });
});

describe("contactCardsOf", () => {
  it("normalizes outbound camelCase cards", () => {
    const cards = contactCardsOf({
      contacts: [
        {
          name: { formattedName: "Jane Doe", firstName: "Jane" },
          phones: [{ phone: "+919812345678", type: "CELL" }],
          emails: [{ email: "jane@example.com", type: "WORK" }]
        }
      ]
    });
    expect(cards).toEqual([{ formattedName: "Jane Doe", phones: ["+919812345678"], emails: ["jane@example.com"] }]);
  });

  it("normalizes inbound Meta snake_case cards", () => {
    const cards = contactCardsOf({
      contacts: [
        {
          name: { formatted_name: "John Smith" },
          phones: [{ phone: "+15551230000", wa_id: "15551230000", type: "CELL" }]
        }
      ]
    });
    expect(cards).toEqual([{ formattedName: "John Smith", phones: ["+15551230000"], emails: [] }]);
  });

  it("falls back to first phone then 'Contact' when name is absent", () => {
    expect(contactCardsOf({ contacts: [{ phones: [{ phone: "+1999" }] }] })[0]!.formattedName).toBe("+1999");
  });

  it("drops junk entries with no name/phone/email and non-object entries", () => {
    expect(contactCardsOf({ contacts: [{ name: {} }, "junk", null, { phones: [] }] })).toEqual([]);
  });

  it("returns [] when contacts is not an array", () => {
    expect(contactCardsOf({})).toEqual([]);
  });
});

describe("interactivePromptOf / interactiveReplyOf", () => {
  it("reads an outbound cta_url prompt (has interactiveType)", () => {
    const prompt = interactivePromptOf({
      interactive: { interactiveType: "cta_url", bodyText: "Hi", ctaDisplayText: "Open", ctaUrl: "https://x.com" }
    });
    expect(prompt?.interactiveType).toBe("cta_url");
    expect(interactiveReplyOf({ interactive: { interactiveType: "cta_url", bodyText: "Hi" } })).toBeUndefined();
  });

  it("reads an inbound button_reply (has kind, no interactiveType)", () => {
    expect(interactiveReplyOf({ interactive: { kind: "button_reply", title: "Yes" } })).toEqual({
      label: "Button reply",
      title: "Yes",
      description: undefined
    });
    expect(interactivePromptOf({ interactive: { kind: "button_reply", title: "Yes" } })).toBeUndefined();
  });

  it("labels list_reply", () => {
    expect(interactiveReplyOf({ interactive: { kind: "list_reply", title: "9am" } })?.label).toBe("List reply");
  });
});

describe("templateOf", () => {
  it("reads templateName/language/parameters", () => {
    expect(
      templateOf({ template: { templateName: "order_update", templateLanguage: "en", parameters: ["Jane"] } })
    ).toEqual({
      templateName: "order_update",
      templateLanguage: "en",
      parameters: ["Jane"]
    });
  });

  it("returns undefined without a templateName", () => {
    expect(templateOf({ template: { templateLanguage: "en" } })).toBeUndefined();
    expect(templateOf({})).toBeUndefined();
  });
});

describe("safeHttpUrl", () => {
  it("accepts http(s) URLs", () => {
    expect(safeHttpUrl("https://example.com/x")).toBe("https://example.com/x");
    expect(safeHttpUrl("http://example.com")).toBe("http://example.com");
  });

  it("rejects javascript:, data:, mailto:, relative junk, and non-strings", () => {
    expect(safeHttpUrl("javascript:alert(1)")).toBeUndefined();
    expect(safeHttpUrl("data:text/html,<script>1</script>")).toBeUndefined();
    expect(safeHttpUrl("mailto:x@y.com")).toBeUndefined();
    expect(safeHttpUrl("/relative/path")).toBeUndefined();
    expect(safeHttpUrl("not a url")).toBeUndefined();
    expect(safeHttpUrl(42)).toBeUndefined();
    expect(safeHttpUrl(undefined)).toBeUndefined();
  });
});

describe("mapsUrl", () => {
  it("builds a maps query from coords", () => {
    expect(mapsUrl({ latitude: 12.97, longitude: 77.59 })).toBe("https://maps.google.com/?q=12.97,77.59");
  });
});

describe("placeholderCount / substituteTemplate", () => {
  it("counts the highest positional index", () => {
    expect(placeholderCount("Hi {{1}}, order {{2}} shipped")).toBe(2);
    expect(placeholderCount("no placeholders")).toBe(0);
    expect(placeholderCount("only {{2}} present")).toBe(2);
  });

  it("substitutes provided parameters", () => {
    expect(substituteTemplate("Hi {{1}}, order {{2}}", ["Jane", "1234"])).toBe("Hi Jane, order 1234");
  });

  it("leaves the literal {{n}} when a parameter is missing or empty", () => {
    expect(substituteTemplate("Hi {{1}}, order {{2}}", ["Jane"])).toBe("Hi Jane, order {{2}}");
    expect(substituteTemplate("Hi {{1}}", [""])).toBe("Hi {{1}}");
  });

  it("returns the body unchanged when no parameters are given", () => {
    expect(substituteTemplate("Hi {{1}}")).toBe("Hi {{1}}");
  });
});
