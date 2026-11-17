/**
 * The sign-in form before React hydrates (a deploy mid-flight answered every
 * `/_next/static/chunks/*` with 400): it must not be submittable, and even a
 * forced native submit must never put the password in a URL.
 */
import { expect, test } from "@playwright/test";

const SECRET = "hunter2-not-a-real-password";

test.describe("login before hydration", { tag: "@smoke" }, () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(async ({ context }) => {
    await context.route("**/_next/static/chunks/**", (r) => r.fulfill({ status: 400, body: "" }));
  });

  test("submit is disabled and says Loading…, and a native submit is a POST with no password in the URL", async ({
    page,
  }) => {
    const urls: string[] = [];
    page.on("request", (r) => urls.push(r.url()));
    await page.goto("/login");
    const form = page.locator('[data-component="LoginForm"]');
    await expect(form).toHaveAttribute("method", "post");
    await expect(form).toHaveAttribute("data-hydrated", "false");
    const submit = form.locator('button[type="submit"]');
    await expect(submit).toBeDisabled();
    await expect(submit).toHaveText("Loading…");

    // Worst case: re-enable everything, type the values, and submit natively.
    await form.evaluate((f, secret) => {
      f.querySelectorAll("fieldset, input, button").forEach((el) => el.removeAttribute("disabled"));
      (f.querySelector('input[name="username"]') as HTMLInputElement).value = "e2e-user";
      (f.querySelector('input[name="password"]') as HTMLInputElement).value = secret;
    }, SECRET);
    const [nav] = await Promise.all([
      page.waitForRequest((r) => r.isNavigationRequest()),
      form.evaluate((f) => (f as HTMLFormElement).requestSubmit()),
    ]);
    expect(nav.method()).toBe("POST");
    expect(nav.url()).not.toContain(SECRET);
    await page.waitForLoadState("load").catch(() => {});
    expect(page.url()).not.toContain(SECRET);
    expect(urls.filter((u) => u.includes(SECRET) || /[?&](password|username)=/.test(u))).toEqual([]);
  });

  test("credentials in the login URL are dropped before the page renders", async ({ page }) => {
    await page.goto(`/login?username=e2e-user&password=${SECRET}&code=123456`);
    expect(page.url()).not.toMatch(/password|username|code=/);
    await expect(page.locator('[data-component="LoginForm"] input[name="password"]')).toHaveValue("");
  });
});
