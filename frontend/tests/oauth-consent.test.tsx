import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  isAxiosError: (err: unknown) =>
    Boolean((err as { isAxiosError?: boolean })?.isAxiosError),
  getOAuthAuthorizationRequest: vi.fn(),
  approveOAuthAuthorizationRequest: vi.fn(),
  denyOAuthAuthorizationRequest: vi.fn(),
}));
vi.mock("../src/api", () => api);
vi.mock("../src/context/AuthContext", () => ({
  useAuth: () => ({ user: { email: "jane@example.com" } }),
}));

import { OAuthConsent } from "../src/pages/OAuthConsent";

const DETAILS = {
  clientName: "Claude Code (excalight)",
  redirectHost: "localhost:4567",
  scopes: [
    "drawings:read",
    "drawings:write",
    "collections:read",
    "collections:write",
  ],
  expiresAt: new Date(Date.now() + 600_000).toISOString(),
};

const textOf = (renderer: ReactTestRenderer): string => {
  const collect = (node: unknown): string => {
    if (typeof node === "string") return node;
    if (!node || typeof node !== "object") return "";
    const children = (node as { children?: unknown[] }).children ?? [];
    return children.map(collect).join("");
  };
  return collect(renderer.toJSON());
};

const findButton = (renderer: ReactTestRenderer, label: string) =>
  renderer.root
    .findAllByType("button")
    .find((node) => node.children.join("") === label)!;

const renderConsent = async (search = "?request=req-123") => {
  const onRedirect = vi.fn();
  let renderer!: ReactTestRenderer;
  await act(async () => {
    renderer = create(
      <MemoryRouter initialEntries={[`/oauth/consent${search}`]}>
        <OAuthConsent onRedirect={onRedirect} />
      </MemoryRouter>,
    );
  });
  return { renderer, onRedirect };
};

describe("OAuth consent page", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.getOAuthAuthorizationRequest.mockResolvedValue(DETAILS);
  });

  it("shows the self-reported client, the requested access and the account", async () => {
    const { renderer } = await renderConsent();
    expect(api.getOAuthAuthorizationRequest).toHaveBeenCalledWith("req-123");
    const text = textOf(renderer);
    expect(text).toContain(
      "Claude Code (excalight) wants to access your drawings",
    );
    expect(text).toContain("is reported by the application itself");
    expect(text).toContain("Create, edit and delete your drawings");
    expect(text).toContain("localhost:4567");
    expect(text).toContain("Signed in as jane@example.com");
    expect(renderer.root.findAllByType("input")).toHaveLength(1);
  });

  it("approves read-only and sends the browser back to the agent", async () => {
    api.approveOAuthAuthorizationRequest.mockResolvedValue({
      redirectUrl: "http://localhost:4567/callback?code=abc&state=xyz",
    });
    const { renderer, onRedirect } = await renderConsent();
    await act(async () => {
      renderer.root
        .findByType("input")
        .props.onChange({ target: { checked: true } });
    });
    expect(textOf(renderer)).not.toContain("Create, edit and delete");
    await act(async () => {
      findButton(renderer, "Allow").props.onClick();
    });
    expect(api.approveOAuthAuthorizationRequest).toHaveBeenCalledWith(
      "req-123",
      true,
    );
    expect(onRedirect).toHaveBeenCalledWith(
      "http://localhost:4567/callback?code=abc&state=xyz",
    );
    expect(textOf(renderer)).toContain("Access granted");
  });

  it("denies and redirects with the error", async () => {
    api.denyOAuthAuthorizationRequest.mockResolvedValue({
      redirectUrl:
        "http://localhost:4567/callback?error=access_denied&state=xyz",
    });
    const { renderer, onRedirect } = await renderConsent();
    await act(async () => {
      findButton(renderer, "Deny").props.onClick();
    });
    expect(api.denyOAuthAuthorizationRequest).toHaveBeenCalledWith("req-123");
    expect(api.approveOAuthAuthorizationRequest).not.toHaveBeenCalled();
    expect(onRedirect).toHaveBeenCalledWith(
      "http://localhost:4567/callback?error=access_denied&state=xyz",
    );
  });

  it("never redirects outside this computer", async () => {
    api.approveOAuthAuthorizationRequest.mockResolvedValue({
      redirectUrl: "https://evil.example/callback?code=abc",
    });
    const { renderer, onRedirect } = await renderConsent();
    await act(async () => {
      findButton(renderer, "Allow").props.onClick();
    });
    expect(onRedirect).not.toHaveBeenCalled();
    expect(textOf(renderer)).toContain("Refusing to redirect");
  });

  it("explains expired or missing requests", async () => {
    api.getOAuthAuthorizationRequest.mockRejectedValue({
      isAxiosError: true,
      response: { data: { message: "This authorization request has expired" } },
    });
    const { renderer } = await renderConsent();
    expect(textOf(renderer)).toContain(
      "This authorization request has expired",
    );
    expect(renderer.root.findAllByType("button")).toHaveLength(0);

    const missing = await renderConsent("");
    expect(textOf(missing.renderer)).toContain(
      "Start the sign-in from your AI agent",
    );
  });
});
