import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Template } from "@hyfib/shared-core";
import { api } from "@/lib/api";
import { TemplatePickerDialog } from "./TemplatePickerDialog";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// Radix Select relies on pointer-capture + scrollIntoView APIs that jsdom omits.
beforeAll(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn();
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

function tmpl(overrides: Partial<Template> & { id: string; name: string; body: string }): Template {
  return { tenantId: "t1", category: "marketing", status: "approved", language: "en", ...overrides };
}

function renderDialog(templates: Template[]) {
  const onOpenChange = vi.fn();
  const getMock = vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path.includes("/templates")) return Promise.resolve({ items: templates });
    return Promise.reject(new Error(`Unhandled GET ${path}`));
  });
  const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "message_enqueued", kind: "template" });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <TemplatePickerDialog conversationId="c1" open onOpenChange={onOpenChange} />
    </QueryClientProvider>
  );
  return { onOpenChange, getMock, postMock, user: userEvent.setup() };
}

async function chooseTemplate(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("combobox", { name: "Template" }));
  await user.click(await screen.findByRole("option", { name }));
}

describe("TemplatePickerDialog", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
  });

  it("fetches approved templates only", async () => {
    const { getMock } = renderDialog([tmpl({ id: "1", name: "order_update", body: "Hi" })]);
    await waitFor(() => expect(getMock).toHaveBeenCalledWith("/api/v1/templates?status=approved"));
  });

  it("shows one parameter input per placeholder and a preview", async () => {
    const { user } = renderDialog([tmpl({ id: "1", name: "order_update", body: "Hi {{1}}, order {{2}} shipped" })]);
    await chooseTemplate(user, "order_update (en)");
    expect(await screen.findByLabelText("{{1}}")).toBeInTheDocument();
    expect(screen.getByLabelText("{{2}}")).toBeInTheDocument();
    expect(screen.getByText("Preview")).toBeInTheDocument();
  });

  it("blocks send and flags empty parameters", async () => {
    const { postMock, user } = renderDialog([tmpl({ id: "1", name: "order_update", body: "Hi {{1}}" })]);
    await chooseTemplate(user, "order_update (en)");
    await user.click(screen.getByRole("button", { name: "Send" }));
    expect(await screen.findByText("Required")).toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });

  it("sends the template with positional parameters", async () => {
    const { postMock, onOpenChange, user } = renderDialog([
      tmpl({ id: "1", name: "order_update", body: "Hi {{1}}, order {{2}}" })
    ]);
    await chooseTemplate(user, "order_update (en)");
    await user.type(await screen.findByLabelText("{{1}}"), "Jane");
    await user.type(screen.getByLabelText("{{2}}"), "1234");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/messages", {
        kind: "template",
        template: { templateName: "order_update", templateLanguage: "en", parameters: ["Jane", "1234"] }
      })
    );
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it("sends a placeholder-free template with no parameters key", async () => {
    const { postMock, user } = renderDialog([tmpl({ id: "1", name: "welcome", body: "Welcome aboard!" })]);
    await chooseTemplate(user, "welcome (en)");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith("/api/v1/conversations/c1/messages", {
        kind: "template",
        template: { templateName: "welcome", templateLanguage: "en" }
      })
    );
  });

  it("shows an empty state when there are no approved templates", async () => {
    renderDialog([]);
    expect(await screen.findByText(/No approved templates/)).toBeInTheDocument();
  });
});
