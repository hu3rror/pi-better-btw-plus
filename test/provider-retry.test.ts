import { describe, expect, test } from "bun:test";
import {
  injectProviderRetry,
  type ProviderRetrySettings,
  type ProviderStreamFn,
} from "../srcs/provider-retry.ts";

function fakeStream() {
  const calls: unknown[] = [];
  const result = { stream: "result" };
  const record = ((
    _model: unknown,
    _context: unknown,
    options?: Record<string, unknown>,
  ) => {
    calls.push(options);
    return result;
  }) as unknown as ProviderStreamFn;
  const forwarding = ((
    model: unknown,
    context: unknown,
    options?: Record<string, unknown>,
  ) => [model, context, options]) as unknown as ProviderStreamFn;
  return { record, forwarding, calls, result };
}

const SETTINGS: ProviderRetrySettings = {
  timeoutMs: 5000,
  maxRetries: 15,
  maxRetryDelayMs: 30000,
};

function call(
  wrapped: ProviderStreamFn,
  model: unknown = null,
  context: unknown = null,
  options: unknown = {},
): any {
  return (wrapped as any)(model, context, options);
}

describe("injectProviderRetry (settings.retry.provider)", () => {
  test("no settings: returns the SAME stream function (identity, zero overhead)", () => {
    const { record } = fakeStream();
    expect(injectProviderRetry(record, undefined)).toBe(record);
  });

  test("empty settings object: identity (no injectable keys)", () => {
    const { record } = fakeStream();
    expect(injectProviderRetry(record, {})).toBe(record);
  });

  test("settings with only undefined keys: identity", () => {
    const { record } = fakeStream();
    expect(
      injectProviderRetry(record, {
        timeoutMs: undefined,
        maxRetries: undefined,
      }),
    ).toBe(record);
  });

  test("settings present: wraps (a NEW function, not the input)", () => {
    const { record } = fakeStream();
    const wrapped = injectProviderRetry(record, { maxRetries: 15 });
    expect(wrapped).not.toBe(record);
  });

  test("missing keys are injected from settings", () => {
    const { record, calls } = fakeStream();
    const wrapped = injectProviderRetry(record, SETTINGS);
    call(wrapped);
    // bun's toEqual ignores undefined-valued keys; all three are set here.
    expect(calls[0]).toEqual({
      timeoutMs: 5000,
      maxRetries: 15,
      maxRetryDelayMs: 30000,
    });
  });

  test("caller's explicit options win over settings (?? order)", () => {
    const { record, calls } = fakeStream();
    const wrapped = injectProviderRetry(record, SETTINGS);
    call(wrapped, null, null, { maxRetries: 2, timeoutMs: 1000 });
    expect(calls[0]).toEqual({
      timeoutMs: 1000,
      maxRetries: 2,
      maxRetryDelayMs: 30000,
    });
  });

  test("unrelated options pass through untouched", () => {
    const { record, calls } = fakeStream();
    const wrapped = injectProviderRetry(record, SETTINGS);
    call(wrapped, null, null, {
      model: "test-model",
      temperature: 0.7,
      maxTokens: 4096,
    });
    expect(calls[0]).toEqual({
      model: "test-model",
      temperature: 0.7,
      maxTokens: 4096,
      timeoutMs: 5000,
      maxRetries: 15,
      maxRetryDelayMs: 30000,
    });
  });

  test("return value passes through (wrapped returns the inner stream result)", () => {
    const { record, result } = fakeStream();
    const wrapped = injectProviderRetry(record, SETTINGS);
    expect(call(wrapped)).toBe(result);
  });

  test("only settings keys present are injected", () => {
    const { record, calls } = fakeStream();
    const wrapped = injectProviderRetry(record, { maxRetries: 15 });
    call(wrapped);
    // bun's toEqual ignores undefined properties, so the other two keys may
    // be present-but-undefined — assert they do NOT carry settings values.
    const options = calls[0] as ProviderRetrySettings;
    expect(options.maxRetries).toBe(15);
    expect(options.timeoutMs).toBeUndefined();
    expect(options.maxRetryDelayMs).toBeUndefined();
  });

  test("model/context are forwarded unchanged", () => {
    const { forwarding } = fakeStream();
    const wrapped = injectProviderRetry(forwarding, SETTINGS);
    const model = { id: "x" };
    const context = { cwd: "/tmp" };
    const forwarded = call(wrapped, model, context) as unknown[];
    expect(forwarded[0]).toBe(model);
    expect(forwarded[1]).toBe(context);
    expect(forwarded[2]).toEqual({
      timeoutMs: 5000,
      maxRetries: 15,
      maxRetryDelayMs: 30000,
    });
  });
});
