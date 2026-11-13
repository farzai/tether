import { describe, expect, it } from "vitest";
import { isAllowedUrl } from "../src/conformance/urls.ts";

describe("isAllowedUrl", () => {
  it.each([
    ["https://app.example", "https://app.example/pair"],
    ["https://app.example", "https://login.example/pair"],
    ["http://127.0.0.1:4000", "http://127.0.0.1:4000/pair"],
    ["http://localhost:4000", "http://localhost:4000/pair"],
    ["http://[::1]:4000", "https://app.example/pair"],
  ])("allows %s to use %s", (origin, url) => {
    expect(isAllowedUrl(origin, url)).toBe(true);
  });

  it.each([
    ["https://app.example", "http://127.0.0.1:4000/pair"],
    ["https://app.example", "http://app.example/pair"],
    ["https://localhost.example", "http://localhost.example/pair"],
    ["https://app.example", "javascript:alert(1)"],
    ["http://127.0.0.1:4000", "javascript:alert(1)"],
    ["http://127.0.0.1:4000", "file:///etc/passwd"],
    ["http://127.0.0.1:4000", "http://app.example/pair"],
    ["http://localhost:4000", "http://10.0.0.1/pair"],
    ["http://[::1]:4000", "http://localhost.example/pair"],
  ])("refuses %s using %s", (origin, url) => {
    expect(isAllowedUrl(origin, url)).toBe(false);
  });
});
