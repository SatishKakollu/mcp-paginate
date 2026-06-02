import { describe, it, expect } from "vitest";
import { defaultTokenCounter, estimateContentTokens } from "../src/tokenize.js";

describe("defaultTokenCounter", () => {
  it("returns ceil(chars/4)", () => {
    expect(defaultTokenCounter("abcd")).toBe(1);
    expect(defaultTokenCounter("abcde")).toBe(2);
    expect(defaultTokenCounter("")).toBe(0);
  });
});

describe("estimateContentTokens", () => {
  it("serializes content before counting", () => {
    const content = [{ type: "text", text: "hello" }];
    const tokens = estimateContentTokens(content, defaultTokenCounter);
    expect(tokens).toBeGreaterThan(0);
  });
});
