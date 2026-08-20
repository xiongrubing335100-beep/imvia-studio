import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createWorkbenchService } from "../src/domain/workbench-service.js";

async function createTestService(context) {
  const dataDirectory = await mkdtemp(path.join(os.tmpdir(), "imvia-account-status-"));
  context.after(() => rm(dataDirectory, { recursive: true, force: true }));
  return { dataDirectory, service: createWorkbenchService({ dataDirectory }) };
}

test("stores fixture billing mode while keeping unavailable balance null", async (context) => {
  const { dataDirectory, service } = await createTestService(context);
  const checkedAt = new Date();
  const updated = await service.updateAccountStatus({
    availability: "partial",
    billing_mode: "fast",
    credit_balance: null,
    credit_unit: null,
    balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
    source_tool: "fixture:lovart_query_billing_mode",
    checked_at: checkedAt.toISOString(),
    expires_at: new Date(checkedAt.getTime() + 300_000).toISOString(),
  });
  assert.equal(updated.account_status.billing_mode, "fast");
  assert.equal(updated.account_status.credit_balance, null);
  assert.equal(updated.account_status.credit_unit, null);

  const reloaded = await createWorkbenchService({ dataDirectory }).getAccountStatus({ max_age_seconds: 300 });
  assert.equal(reloaded.account_status.balance_reason, "UPSTREAM_CAPABILITY_UNAVAILABLE");
  assert.equal(reloaded.stale, false);
});

test("marks expired cache stale and rejects invented or incomplete balances", async (context) => {
  const { service } = await createTestService(context);
  await service.updateAccountStatus({
    availability: "partial",
    billing_mode: "fast",
    credit_balance: null,
    credit_unit: null,
    balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
    source_tool: "fixture:billing",
    checked_at: "2020-01-01T00:00:00.000Z",
    expires_at: "2020-01-01T00:05:00.000Z",
  });
  assert.equal((await service.getAccountStatus({ max_age_seconds: 300 })).stale, true);
  await assert.rejects(
    () => service.updateAccountStatus({ availability: "available", billing_mode: "fast", credit_balance: 100, credit_unit: null, balance_reason: null, source_tool: "fixture:billing", checked_at: "2026-08-20T00:00:00.000Z" }),
    (error) => error.code === "VALIDATION_FAILED",
  );
  await assert.rejects(
    () => service.updateAccountStatus({ availability: "partial", billing_mode: "fast", credit_balance: null, credit_unit: null, balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE", source_tool: "lovart:billing", checked_at: "2026-08-20T00:00:00.000Z" }),
    (error) => error.code === "VALIDATION_FAILED",
  );
});

test("normalizes omitted nullable fields for direct account-status callers", async (context) => {
  const { dataDirectory, service } = await createTestService(context);
  const updated = await service.updateAccountStatus({
    availability: "partial",
    balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
    source_tool: "fixture:billing",
    checked_at: "2026-08-20T00:00:00.000Z",
  });

  assert.equal(updated.account_status.billing_mode, null);
  assert.equal(updated.account_status.credit_balance, null);
  assert.equal(updated.account_status.credit_unit, null);

  const reloaded = await createWorkbenchService({ dataDirectory }).getAccountStatus();
  assert.equal(reloaded.account_status.billing_mode, null);
  assert.equal(reloaded.account_status.credit_balance, null);
  assert.equal(reloaded.account_status.credit_unit, null);
});

test("rejects malformed, non-canonical, inverted, and future account timestamps before persistence", async (context) => {
  const { service } = await createTestService(context);
  const base = {
    availability: "partial",
    billing_mode: "fast",
    credit_balance: null,
    credit_unit: null,
    balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
    source_tool: "fixture:billing",
    checked_at: "2026-08-20T00:00:00.000Z",
    expires_at: "2026-08-20T00:05:00.000Z",
  };
  const cases = [
    { name: "malformed checked time", input: { ...base, checked_at: "not-a-date" }, field: "checked_at" },
    { name: "non-canonical checked time", input: { ...base, checked_at: "2026-08-20T08:00:00.000+08:00" }, field: "checked_at" },
    { name: "invalid calendar time", input: { ...base, checked_at: "2026-02-30T00:00:00.000Z" }, field: "checked_at" },
    { name: "inverted expiry", input: { ...base, expires_at: "2026-08-19T23:59:59.999Z" }, field: "expires_at" },
    {
      name: "unreasonable future checked time",
      input: {
        ...base,
        checked_at: new Date(Date.now() + 6 * 60_000).toISOString(),
        expires_at: new Date(Date.now() + 12 * 60_000).toISOString(),
      },
      field: "checked_at",
    },
  ];

  for (const fixtureCase of cases) {
    await assert.rejects(
      () => service.updateAccountStatus(fixtureCase.input),
      (error) => error.code === "VALIDATION_FAILED" && error.details.field === fixtureCase.field,
      fixtureCase.name,
    );
  }

  const current = await service.getAccountStatus();
  assert.deepEqual(current.account_status, {
    availability: "unavailable",
    billing_mode: null,
    credit_balance: null,
    credit_unit: null,
    balance_reason: "UPSTREAM_CAPABILITY_UNAVAILABLE",
    source_tool: null,
    checked_at: null,
    expires_at: null,
  });
});
