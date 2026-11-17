import { describe, expect, it } from "vitest";

import { stripLoginCredentials } from "./login-query";

describe("stripLoginCredentials", () => {
  it("drops username, password and code and keeps the rest", () => {
    const clean = stripLoginCredentials(
      new URL("https://a.example/login?username=alice&password=hunter2&code=123456&profile=hr"),
    );
    expect(clean?.href).toBe("https://a.example/login?profile=hr");
  });

  it("returns null when the URL carries none", () => {
    expect(stripLoginCredentials(new URL("https://a.example/login?profile=hr"))).toBeNull();
    expect(stripLoginCredentials(new URL("https://a.example/login"))).toBeNull();
  });

  it("strips empty and repeated values too", () => {
    expect(stripLoginCredentials(new URL("https://a.example/login?password=&password=x"))?.href).toBe(
      "https://a.example/login",
    );
  });
});
