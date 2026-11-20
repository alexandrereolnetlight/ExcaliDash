import type { ReactElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it } from "vitest";
import { UserAvatar } from "../src/components/UserAvatar";
import { toHttpsAvatarUrl } from "../src/utils/user";

const PHOTO = "https://photos.api.prd.aws.netlight.com/medium/jado.jpg";
const OTHER_PHOTO = "https://photos.api.prd.aws.netlight.com/medium/other.jpg";

const render = (element: ReactElement): ReactTestRenderer => {
  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(element);
  });
  return renderer;
};

describe("UserAvatar", () => {
  it("renders initials without an avatar URL", () => {
    const renderer = render(<UserAvatar name="Jane Doe" />);
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    const wrapper = renderer.root.findByProps({ role: "img" });
    expect(wrapper.props["aria-label"]).toBe("Jane Doe's profile picture");
    expect(wrapper.children).toEqual(["JD"]);
  });

  it("renders a decorative, non-referring image when an avatar URL is set", () => {
    const renderer = render(<UserAvatar name="Jane Doe" avatarUrl={PHOTO} />);
    const img = renderer.root.findByType("img");
    expect(img.props.src).toBe(PHOTO);
    expect(img.props.alt).toBe("");
    expect(img.props.referrerPolicy).toBe("no-referrer");
    expect(img.props.loading).toBe("lazy");
    expect(img.props.decoding).toBe("async");
    expect(renderer.root.findByProps({ role: "img" }).props["aria-label"]).toBe(
      "Jane Doe's profile picture",
    );
  });

  it("falls back to initials on load error and retries a new URL", () => {
    const renderer = render(<UserAvatar name="Jane Doe" avatarUrl={PHOTO} />);
    act(() => {
      renderer.root.findByType("img").props.onError();
    });
    expect(renderer.root.findAllByType("img")).toHaveLength(0);
    expect(renderer.root.findByProps({ role: "img" }).children).toEqual(["JD"]);

    act(() => {
      renderer.update(<UserAvatar name="Jane Doe" avatarUrl={OTHER_PHOTO} />);
    });
    expect(renderer.root.findByType("img").props.src).toBe(OTHER_PHOTO);
  });
});

describe("toHttpsAvatarUrl", () => {
  it("only passes https URLs through to Excalidraw", () => {
    expect(toHttpsAvatarUrl(PHOTO)).toBe(PHOTO);
    expect(toHttpsAvatarUrl(null)).toBeUndefined();
    expect(toHttpsAvatarUrl("")).toBeUndefined();
    expect(toHttpsAvatarUrl("http://example.com/a.jpg")).toBeUndefined();
    expect(toHttpsAvatarUrl("javascript:alert(1)")).toBeUndefined();
    expect(toHttpsAvatarUrl("not a url")).toBeUndefined();
  });
});
