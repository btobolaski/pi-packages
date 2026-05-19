import { describe, expect, it } from "vitest";

import { DEFAULT_EXTENSION_CONFIG } from "#src/extension-config";
import {
  extractDomainFromUrl,
  isWebAccessTool,
  shouldAllowFetchForDomain,
  shouldAllowWebSearch,
  WEB_ACCESS_TOOLS,
  WEB_SEARCH_TOOLS,
} from "#src/web-access";

const allowConfig = { ...DEFAULT_EXTENSION_CONFIG, allowWebAccess: true };

describe("extractDomainFromUrl", () => {
  it("returns the lowercased hostname for absolute URLs", () => {
    expect(extractDomainFromUrl({ url: "https://Example.COM/path" })).toBe(
      "example.com",
    );
  });

  it("prefixes https:// when the URL has no scheme", () => {
    expect(extractDomainFromUrl({ url: "example.com/path" })).toBe(
      "example.com",
    );
  });

  it("returns null for missing/blank urls", () => {
    expect(extractDomainFromUrl({})).toBeNull();
    expect(extractDomainFromUrl({ url: "   " })).toBeNull();
    expect(extractDomainFromUrl({ url: 42 })).toBeNull();
    expect(extractDomainFromUrl(null)).toBeNull();
  });

  it("returns null for non-parseable URL fragments", () => {
    expect(extractDomainFromUrl({ url: "::invalid::" })).toBeNull();
  });
});

describe("isWebAccessTool", () => {
  it("recognizes all web-access tools", () => {
    for (const tool of WEB_ACCESS_TOOLS) {
      expect(isWebAccessTool(tool)).toBe(true);
    }
  });

  it("does not recognize unrelated tools", () => {
    expect(isWebAccessTool("bash")).toBe(false);
    expect(isWebAccessTool("edit")).toBe(false);
  });
});

describe("shouldAllowWebSearch", () => {
  it("returns true for search tools when allowWebAccess is on", () => {
    for (const tool of WEB_SEARCH_TOOLS) {
      expect(shouldAllowWebSearch(tool, allowConfig)).toBe(true);
    }
  });

  it("returns false for fetch_content even when allowWebAccess is on", () => {
    expect(shouldAllowWebSearch("fetch_content", allowConfig)).toBe(false);
  });

  it("returns false when allowWebAccess is off", () => {
    for (const tool of WEB_SEARCH_TOOLS) {
      expect(shouldAllowWebSearch(tool, DEFAULT_EXTENSION_CONFIG)).toBe(false);
    }
  });
});

describe("shouldAllowFetchForDomain", () => {
  it("returns true when domain is in the configured list", () => {
    const config = {
      ...allowConfig,
      allowedFetchDomains: ["example.com"],
    };
    expect(
      shouldAllowFetchForDomain(
        "fetch_content",
        { url: "https://example.com/x" },
        config,
        new Set(),
      ),
    ).toBe(true);
  });

  it("returns true when domain is in the session-allowed set", () => {
    expect(
      shouldAllowFetchForDomain(
        "fetch_content",
        { url: "https://example.com/x" },
        allowConfig,
        new Set(["example.com"]),
      ),
    ).toBe(true);
  });

  it("returns false when the domain matches neither list", () => {
    expect(
      shouldAllowFetchForDomain(
        "fetch_content",
        { url: "https://example.com/x" },
        allowConfig,
        new Set(),
      ),
    ).toBe(false);
  });

  it("returns false for non-fetch tools", () => {
    expect(
      shouldAllowFetchForDomain(
        "web_search",
        { url: "https://example.com" },
        { ...allowConfig, allowedFetchDomains: ["example.com"] },
        new Set(),
      ),
    ).toBe(false);
  });

  it("returns false when allowWebAccess is off", () => {
    expect(
      shouldAllowFetchForDomain(
        "fetch_content",
        { url: "https://example.com" },
        {
          ...DEFAULT_EXTENSION_CONFIG,
          allowedFetchDomains: ["example.com"],
        },
        new Set(["example.com"]),
      ),
    ).toBe(false);
  });

  it("returns false when the URL cannot be parsed", () => {
    expect(
      shouldAllowFetchForDomain(
        "fetch_content",
        { url: "::invalid::" },
        { ...allowConfig, allowedFetchDomains: ["example.com"] },
        new Set(),
      ),
    ).toBe(false);
  });
});
