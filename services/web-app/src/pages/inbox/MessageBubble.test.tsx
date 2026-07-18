import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Message, Template } from "@hyfib/shared-core";
import { api } from "@/lib/api";
import { MessageBubble } from "./MessageBubble";

function msg(overrides: Partial<Message> & { id: string; payload: Record<string, unknown> }): Message {
  return {
    tenantId: "t1",
    conversationId: "c1",
    direction: "outbound",
    status: "sent",
    createdAt: "2026-07-15T00:00:00.000Z",
    ...overrides
  };
}

function tmpl(overrides: Partial<Template> & { name: string; body: string }): Template {
  return {
    id: "tpl1",
    tenantId: "t1",
    category: "marketing",
    status: "approved",
    language: "en",
    ...overrides
  };
}

function renderBubble(message: Message, templates: Template[] = []) {
  const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/templates")) return Promise.resolve({ items: templates });
    return Promise.reject(new Error(`Unhandled GET ${path}`));
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MessageBubble message={message} />
    </QueryClientProvider>
  );
  return { getMock };
}

describe("MessageBubble", () => {
  afterEach(() => vi.restoreAllMocks());

  it("renders an outbound location with name, address, and a safe Open in maps link", () => {
    renderBubble(
      msg({
        id: "m1",
        payload: { kind: "location", location: { latitude: 12.97, longitude: 77.59, name: "HQ", address: "MG Road" } }
      })
    );
    expect(screen.getByText("HQ")).toBeInTheDocument();
    expect(screen.getByText("MG Road")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "Open in maps" });
    expect(link).toHaveAttribute("href", "https://maps.google.com/?q=12.97,77.59");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders an inbound location without coordinates as text, with no maps link", () => {
    renderBubble(
      msg({
        id: "m2",
        direction: "inbound",
        payload: { type: "location", text: "Somewhere nice", location: { name: "Somewhere nice" } }
      })
    );
    expect(screen.getByText("Somewhere nice")).toBeInTheDocument();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("renders outbound contact cards with name, phone, and email", () => {
    renderBubble(
      msg({
        id: "m3",
        payload: {
          kind: "contacts",
          contacts: [
            {
              name: { formattedName: "Jane Doe" },
              phones: [{ phone: "+919812345678" }],
              emails: [{ email: "jane@example.com" }]
            }
          ]
        }
      })
    );
    expect(screen.getByText("Jane Doe")).toBeInTheDocument();
    expect(screen.getByText("+919812345678")).toBeInTheDocument();
    expect(screen.getByText("jane@example.com")).toBeInTheDocument();
  });

  it("renders an inbound Meta snake_case contact card", () => {
    renderBubble(
      msg({
        id: "m4",
        direction: "inbound",
        payload: {
          type: "contacts",
          contacts: [{ name: { formatted_name: "John Smith" }, phones: [{ phone: "+1555" }] }]
        }
      })
    );
    expect(screen.getByText("John Smith")).toBeInTheDocument();
    expect(screen.getByText("+1555")).toBeInTheDocument();
  });

  it("renders an interactive button prompt with disabled button pills", () => {
    renderBubble(
      msg({
        id: "m5",
        payload: {
          kind: "interactive",
          interactive: {
            interactiveType: "button",
            bodyText: "Confirm your order?",
            buttons: [
              { id: "yes", title: "Yes" },
              { id: "no", title: "No" }
            ]
          }
        }
      })
    );
    expect(screen.getByText("Confirm your order?")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Yes" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "No" })).toBeDisabled();
  });

  it("renders an interactive list prompt as an option-count summary", () => {
    renderBubble(
      msg({
        id: "m6",
        payload: {
          kind: "interactive",
          interactive: {
            interactiveType: "list",
            bodyText: "Pick a slot",
            buttonLabel: "Choose",
            sections: [
              {
                title: "Morning",
                rows: [
                  { id: "9", title: "9am" },
                  { id: "10", title: "10am" }
                ]
              }
            ]
          }
        }
      })
    );
    expect(screen.getByText(/Choose · 2 options/)).toBeInTheDocument();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("renders a cta_url with a safe http(s) anchor", () => {
    renderBubble(
      msg({
        id: "m7",
        payload: {
          kind: "interactive",
          interactive: {
            interactiveType: "cta_url",
            bodyText: "View your invoice",
            ctaDisplayText: "Open invoice",
            ctaUrl: "https://example.com/inv/1"
          }
        }
      })
    );
    const link = screen.getByRole("link", { name: "Open invoice" });
    expect(link).toHaveAttribute("href", "https://example.com/inv/1");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("never renders a javascript: cta_url as a link", () => {
    renderBubble(
      msg({
        id: "m8",
        payload: {
          kind: "interactive",
          interactive: {
            interactiveType: "cta_url",
            bodyText: "Sketchy",
            ctaDisplayText: "Click me",
            ctaUrl: "javascript:alert(1)"
          }
        }
      })
    );
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText(/Click me:/)).toBeInTheDocument();
  });

  it("labels an inbound button_reply", () => {
    renderBubble(
      msg({
        id: "m9",
        direction: "inbound",
        payload: { type: "interactive", interactive: { kind: "button_reply", title: "Yes please" } }
      })
    );
    expect(screen.getByText("Yes please")).toBeInTheDocument();
    expect(screen.getByText("Button reply")).toBeInTheDocument();
  });

  it("resolves a template body from the shared templates cache and substitutes parameters", async () => {
    renderBubble(
      msg({
        id: "m10",
        payload: {
          kind: "template",
          template: { templateName: "summer_offer_v1", templateLanguage: "en", parameters: ["Jane"] }
        }
      }),
      [tmpl({ name: "summer_offer_v1", language: "en", body: "Hi {{1}}, enjoy 20% off." })]
    );
    expect(await screen.findByText("Hi Jane, enjoy 20% off.")).toBeInTheDocument();
    expect(screen.getByText(/Template: summer_offer_v1 \(en\)/)).toBeInTheDocument();
  });

  it("falls back to parameter chips when the template is not in cache", async () => {
    const { getMock } = renderBubble(
      msg({
        id: "m11",
        payload: {
          kind: "template",
          template: { templateName: "unknown_tpl", templateLanguage: "en", parameters: ["Jane"] }
        }
      }),
      []
    );
    await vi.waitFor(() => expect(getMock).toHaveBeenCalled());
    expect(screen.getByText(/Template: unknown_tpl \(en\)/)).toBeInTheDocument();
    expect(screen.getByText("Jane")).toBeInTheDocument();
    expect(screen.queryByText(/enjoy 20% off/)).toBeNull();
  });

  it("flags a failed outbound message with an explainer", () => {
    renderBubble(msg({ id: "m12", status: "failed", payload: { kind: "text", text: "oops" } }));
    expect(screen.getByText(/Not delivered/)).toBeInTheDocument();
  });

  it("shows a normal status line for a delivered outbound and no failure explainer", () => {
    renderBubble(msg({ id: "m13", status: "delivered", payload: { kind: "text", text: "hey" } }));
    expect(screen.getByText(/· delivered/)).toBeInTheDocument();
    expect(screen.queryByText(/Not delivered/)).toBeNull();
  });

  it("renders plain text and unknown kinds via the text fallback", () => {
    const { unmount } = render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MessageBubble message={msg({ id: "m14", payload: { kind: "text", text: "hello there" } })} />
      </QueryClientProvider>
    );
    expect(screen.getByText("hello there")).toBeInTheDocument();
    unmount();

    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MessageBubble message={msg({ id: "m15", payload: { kind: "flow" } })} />
      </QueryClientProvider>
    );
    expect(screen.getByText("[flow]")).toBeInTheDocument();
  });
});
