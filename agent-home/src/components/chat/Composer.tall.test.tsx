// @vitest-environment jsdom
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { Composer } from "@/components/chat/Composer";

afterEach(cleanup);

function composer(props: Partial<Parameters<typeof Composer>[0]> = {}) {
  render(<Composer sending={false} storageEnabled sessionId="s1" onSend={() => {}} {...props} />);
  const root = document.querySelector<HTMLElement>('[data-component="Composer"]')!;
  return { root, textarea: root.querySelector("textarea")! };
}

describe("Composer tall (phone chat page)", () => {
  it("uses touch-sized actions below lg", () => {
    const { root, textarea } = composer({ tall: true });
    expect(textarea.dataset.tall).toBe("true");
    expect(root.querySelector('[aria-label="Attach file"]')!.className).toContain("max-lg:h-11");
    expect(root.querySelector('[data-component="SecretLockButton"]')!.className).toContain("max-lg:w-11");
  });

  it("reserves launcher space only on desktop with launcherClearance=desktop", () => {
    const { root } = composer({ tall: true, launcherClearance: "desktop", sending: true });
    expect(root.className).toContain("lg:ml-14");
    expect(root.className).not.toMatch(/(^|\s)ml-14/);
    expect(root.querySelector('[aria-label="Attach file"]')!.className).not.toContain("ml-14");
  });

  it("leaves the default composer without the below-lg sizing", () => {
    const { root, textarea } = composer();
    expect(textarea.dataset.tall).toBeUndefined();
    expect(root.querySelector('[aria-label="Attach file"]')!.className).not.toContain("max-lg:");
    expect(root.className).toMatch(/(^|\s)ml-14/);
  });
});
