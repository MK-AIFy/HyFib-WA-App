import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Campaign } from "@hyfib/shared-core";
import { api } from "@/lib/api";
import { CampaignsPage } from "./CampaignsPage";
import { campaignActions } from "./campaign-actions";

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeAll(() => {
  // Radix primitives need pointer-capture + scrollIntoView in jsdom.
  HTMLElement.prototype.hasPointerCapture = vi.fn();
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  HTMLElement.prototype.scrollIntoView = vi.fn();
});

function campaign(overrides: Partial<Campaign> & { id: string; status: Campaign["status"] }): Campaign {
  return {
    tenantId: "t1",
    name: `Campaign ${overrides.id}`,
    templateId: "tpl-1",
    templateCategory: "marketing",
    createdAt: "2026-07-29T00:00:00.000Z",
    ...overrides
  };
}

const CAMPAIGNS = [
  campaign({ id: "c-draft", status: "draft", name: "Draft campaign" }),
  campaign({ id: "c-paused", status: "paused", name: "Paused campaign" }),
  campaign({ id: "c-done", status: "completed", name: "Done campaign" })
];

function renderPage() {
  vi.spyOn(api, "get").mockImplementation((path: string) => {
    if (path === "/api/v1/campaigns") return Promise.resolve({ items: CAMPAIGNS });
    if (path === "/api/v1/templates" || path === "/api/v1/segments") return Promise.resolve({ items: [] });
    if (path.endsWith("/report"))
      return Promise.resolve({
        campaign: CAMPAIGNS[2],
        funnel: { sent: 40, delivered: 35, read: 12, failed: 5 },
        recipients: [{ id: "r1" }, { id: "r2" }]
      });
    return Promise.reject(new Error(`Unhandled GET ${path}`));
  });
  const postMock = vi.spyOn(api, "post").mockResolvedValue({ status: "ok", recipientCount: 7 });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <CampaignsPage />
    </QueryClientProvider>
  );
  return { postMock };
}

describe("campaignActions", () => {
  it("mirrors the gateway transition matrix", () => {
    expect(campaignActions("draft")).toEqual(["run", "cancel"]);
    expect(campaignActions("scheduled")).toEqual(["pause", "cancel"]);
    expect(campaignActions("running")).toEqual(["pause", "cancel"]);
    expect(campaignActions("paused")).toEqual(["resume", "cancel"]);
    expect(campaignActions("completed")).toEqual([]);
    expect(campaignActions("cancelled")).toEqual([]);
  });
});

describe("CampaignsPage actions", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("Run on a draft campaign POSTs to /run (regression: used to hit /dispatch with no body)", async () => {
    const { postMock } = renderPage();
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: "Run" }));

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/campaigns/c-draft/run", {}));
  });

  it("a paused campaign offers Resume (not Run) and POSTs to /resume", async () => {
    const { postMock } = renderPage();
    const user = userEvent.setup();

    const resume = await screen.findByRole("button", { name: "Resume" });
    expect(screen.getAllByRole("button", { name: "Run" })).toHaveLength(1); // only the draft row
    await user.click(resume);

    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/campaigns/c-paused/resume", {}));
  });

  it("Cancel requires confirmation and then POSTs to /cancel", async () => {
    const { postMock } = renderPage();
    const user = userEvent.setup();

    const cancels = await screen.findAllByRole("button", { name: "Cancel" });
    await user.click(cancels[0]!);
    expect(postMock).not.toHaveBeenCalled();

    await user.click(await screen.findByRole("button", { name: "Cancel campaign" }));
    await waitFor(() => expect(postMock).toHaveBeenCalledWith("/api/v1/campaigns/c-draft/cancel", {}));
  });

  it("completed campaigns get no lifecycle buttons, only Report", async () => {
    renderPage();
    await screen.findByText("Done campaign");

    // 3 rows → 3 Report buttons; lifecycle buttons only on draft + paused rows.
    expect(screen.getAllByRole("button", { name: "Report" })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(2);
  });

  it("Report dialog fetches the funnel and renders counts", async () => {
    renderPage();
    const user = userEvent.setup();

    const reports = await screen.findAllByRole("button", { name: "Report" });
    await user.click(reports[2]!);

    await screen.findByText("Done campaign — delivery report");
    expect(await screen.findByText("40")).toBeInTheDocument();
    expect(screen.getByText("35")).toBeInTheDocument();
    expect(screen.getByText("2 recipients shown (first 500).")).toBeInTheDocument();
  });
});
