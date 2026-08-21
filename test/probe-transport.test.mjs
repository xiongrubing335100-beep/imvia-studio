import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import { requestLovartModeQuery } from "../src/probe/transport.js";

function createHttpsHarness(scenarios) {
  const calls = [];

  function request(options, onResponse) {
    const scenario = scenarios[calls.length] ?? scenarios.at(-1);
    const requestEmitter = new EventEmitter();
    const call = {
      options,
      body: "",
      destroyed: false,
      destroyError: null,
      destroyCalls: 0,
      endCalls: 0,
      onceEvents: [],
      writeCalls: 0,
    };
    calls.push(call);

    const emitterOnce = requestEmitter.once.bind(requestEmitter);
    requestEmitter.once = (event, listener) => {
      call.onceEvents.push(event);
      return emitterOnce(event, listener);
    };
    requestEmitter.write = (chunk) => {
      call.writeCalls += 1;
      if (scenario?.type === "write-throw") throw scenario.error;
      call.body += String(chunk);
    };
    requestEmitter.end = () => {
      call.endCalls += 1;
      if (scenario?.type === "end-throw") throw scenario.error;
      if (scenario?.type === "pending") return;
      if (scenario?.type === "request-error") {
        queueMicrotask(() => requestEmitter.emit("error", scenario.error));
        return;
      }

      queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = scenario?.statusCode ?? 200;
        response.destroyed = false;
        response.destroy = () => {
          response.destroyed = true;
          call.responseDestroyed = true;
        };
        onResponse(response);

        if (scenario?.type === "response-error") {
          response.emit("error", scenario.error);
          response.emit("end");
          return;
        }
        if (scenario?.type === "response-aborted") {
          response.emit("aborted");
          response.emit("end");
          return;
        }
        for (const chunk of scenario?.chunks ?? [scenario?.body ?? "{}"])
          response.emit("data", chunk);
        response.emit("end");
      });
    };
    requestEmitter.destroy = (error) => {
      call.destroyCalls += 1;
      call.destroyed = true;
      call.destroyError = error;
      if (error) requestEmitter.emit("error", error);
    };

    return requestEmitter;
  }

  return { calls, request };
}

function installTimerHarness(t) {
  const timers = [];
  const cleared = [];
  t.mock.method(globalThis, "setTimeout", (callback, delay) => {
    const handle = { callback, delay };
    timers.push(handle);
    return handle;
  });
  t.mock.method(globalThis, "clearTimeout", (handle) => {
    cleared.push(handle);
  });
  return {
    assertSingleFixedTimerCleared() {
      assert.equal(timers.length, 1);
      assert.equal(timers[0].delay, 8_000);
      assert.deepEqual(cleared, [timers[0]]);
    },
    fire() {
      assert.equal(timers.length, 1);
      timers[0].callback();
    },
  };
}

function assertRedacted(error, markers = []) {
  const serialized = JSON.stringify({
    name: error.name,
    code: error.code,
    message: error.message,
    details: error.details,
    stack: error.stack,
  });
  for (const marker of markers)
    assert.equal(serialized.includes(marker), false, `error leaked ${marker}`);
  assert.deepEqual(error.details, {});
  return true;
}

async function assertFailure({ scenario, code, markers = [] }) {
  const fake = createHttpsHarness([scenario]);
  await assert.rejects(
    requestLovartModeQuery({
      accessKey: "marker-access",
      secretKey: "marker-secret",
      requestImpl: fake.request,
    }),
    (error) => {
      assert.equal(error.code, code);
      assertRedacted(error, ["marker-access", "marker-secret", ...markers]);
      return true;
    },
  );
  assert.equal(fake.calls.length, 1);
  return fake.calls[0];
}

test("transport performs exactly one fixed signed request", async () => {
  const fake = createHttpsHarness([{ statusCode: 200, body: '{"unlimited":true}' }]);
  let randomIdCalls = 0;
  const result = await requestLovartModeQuery({
    accessKey: "marker-access",
    secretKey: "marker-secret",
    nowSeconds: () => 1_777_000_000,
    randomId: () => {
      randomIdCalls += 1;
      return "01234567-89ab-cdef-0123-456789abcdef";
    },
    requestImpl: fake.request,
  });

  assert.deepEqual(result, { unlimited: true });
  assert.equal(randomIdCalls, 1);
  assert.equal(fake.calls.length, 1);
  assert.deepEqual(fake.calls[0].options, {
    protocol: "https:",
    hostname: "lgw.lovart.ai",
    port: 443,
    agent: false,
    method: "POST",
    path: "/v1/openapi/mode/query",
    rejectUnauthorized: true,
    headers: {
      "Content-Type": "application/json",
      "Content-Length": 2,
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) LovartAgentSkill/1.0",
      "X-Access-Key": "marker-access",
      "X-Timestamp": "1777000000",
      "X-Signature": "d06d635f217734bca2a04a713656425fe5dec4e08aa1bb1bfe28050f10a783aa",
      "X-Signed-Method": "POST",
      "X-Signed-Path": "/v1/openapi/mode/query",
      "Idempotency-Key": "0123456789abcdef0123456789abcdef",
    },
  });
  assert.equal(fake.calls[0].body, "{}");
  assert.equal(JSON.stringify(fake.calls[0]).includes("marker-secret"), false);
});

test("proxy environment variables cannot change the fixed direct request", async () => {
  const previous = {
    HTTP_PROXY: process.env.HTTP_PROXY,
    HTTPS_PROXY: process.env.HTTPS_PROXY,
    ALL_PROXY: process.env.ALL_PROXY,
  };
  process.env.HTTP_PROXY = "http://marker-proxy.invalid:8080";
  process.env.HTTPS_PROXY = "http://marker-proxy.invalid:8080";
  process.env.ALL_PROXY = "socks://marker-proxy.invalid:1080";

  try {
    const fake = createHttpsHarness([{ statusCode: 200, body: "{}" }]);
    await requestLovartModeQuery({
      accessKey: "a",
      secretKey: "s",
      randomId: () => "0123456789abcdef0123456789abcdef",
      requestImpl: fake.request,
    });
    assert.equal(fake.calls.length, 1);
    assert.equal("proxy" in fake.calls[0].options, false);
    assert.equal(fake.calls[0].options.agent, false);
    assert.equal(JSON.stringify(fake.calls[0].options).includes("marker-proxy"), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});

test("the eight-second wall-clock timeout destroys one request without retry", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const fake = createHttpsHarness([{ type: "pending" }]);
  const outcome = requestLovartModeQuery({
    accessKey: "a",
    secretKey: "s",
    requestImpl: fake.request,
  });

  t.mock.timers.tick(7_999);
  assert.equal(fake.calls[0].destroyed, false);
  t.mock.timers.tick(1);

  await assert.rejects(outcome, (error) => {
    assert.equal(error.code, "UPSTREAM_UNREACHABLE");
    assertRedacted(error);
    return true;
  });
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].destroyed, true);
  assert.equal(fake.calls[0].destroyError.code, "UPSTREAM_UNREACHABLE");
});

for (const statusCode of [301, 307, 308]) {
  test(`HTTP ${statusCode} redirects are rejected without following`, async () => {
    await assertFailure({
      scenario: { statusCode, body: "https://marker-redirect.invalid/secret" },
      code: "UPSTREAM_SECURITY_REJECTED",
      markers: ["marker-redirect", "secret"],
    });
  });
}

for (const statusCode of [401, 403]) {
  test(`HTTP ${statusCode} maps to stable authentication failure without retry`, async () => {
    await assertFailure({
      scenario: { statusCode, body: "upstream marker-auth details" },
      code: "AUTHENTICATION_FAILED",
      markers: ["marker-auth"],
    });
  });
}

test("HTTP 429 maps to stable rate limiting without retry", async () => {
  await assertFailure({
    scenario: { statusCode: 429, body: "upstream marker-rate details" },
    code: "UPSTREAM_RATE_LIMITED",
    markers: ["marker-rate"],
  });
});

test("failures omit credentials, signing metadata, and upstream response text", async () => {
  const fake = createHttpsHarness([{ statusCode: 500, body: "marker-upstream-raw-body" }]);
  await assert.rejects(
    requestLovartModeQuery({
      accessKey: "marker-access",
      secretKey: "marker-secret",
      nowSeconds: () => 1_777_000_000,
      randomId: () => "0123456789abcdef0123456789abcdef",
      requestImpl: fake.request,
    }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_UNAVAILABLE");
      assertRedacted(error, [
        "marker-access",
        "marker-secret",
        "1777000000",
        "d06d635f217734bca2a04a713656425fe5dec4e08aa1bb1bfe28050f10a783aa",
        "0123456789abcdef0123456789abcdef",
        "marker-upstream-raw-body",
      ]);
      return true;
    },
  );
  assert.equal(fake.calls.length, 1);
});

for (const statusCode of [500, 503, 599]) {
  test(`HTTP ${statusCode} maps to stable upstream unavailability without retry`, async () => {
    await assertFailure({
      scenario: { statusCode, body: "upstream marker-outage details" },
      code: "UPSTREAM_UNAVAILABLE",
      markers: ["marker-outage"],
    });
  });
}

test("DNS and connection errors map to redacted upstream-unreachable failures", async () => {
  const error = Object.assign(new Error("ENOTFOUND marker-access marker-secret"), { code: "ENOTFOUND" });
  await assertFailure({
    scenario: { type: "request-error", error },
    code: "UPSTREAM_UNREACHABLE",
    markers: ["ENOTFOUND"],
  });
});

for (const tlsCode of [
  "CERT_HAS_EXPIRED",
  "ERR_TLS_CERT_ALTNAME_INVALID",
  "INVALID_CA",
  "INVALID_PURPOSE",
  "PATH_LENGTH_EXCEEDED",
  "CRL_HAS_EXPIRED",
  "ERROR_IN_CERT_NOT_AFTER_FIELD",
  "UNABLE_TO_GET_CRL_ISSUER",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
]) {
  test(`${tlsCode} maps to a redacted TLS security failure`, async () => {
    const error = Object.assign(new Error(`TLS marker-upstream ${tlsCode}`), { code: tlsCode });
    await assertFailure({
      scenario: { type: "request-error", error },
      code: "UPSTREAM_SECURITY_REJECTED",
      markers: ["marker-upstream", tlsCode],
    });
  });
}

for (const networkCode of ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"]) {
  test(`${networkCode} remains an ordinary upstream-unreachable failure`, async () => {
    const error = Object.assign(new Error(`network marker ${networkCode}`), { code: networkCode });
    await assertFailure({
      scenario: { type: "request-error", error },
      code: "UPSTREAM_UNREACHABLE",
      markers: [networkCode, "network marker"],
    });
  });
}

for (const [label, scenario, expectedCode] of [
  ["success", { statusCode: 200, body: "{}" }, null],
  ["status error", { statusCode: 429, body: "ignored" }, "UPSTREAM_RATE_LIMITED"],
  ["response error", {
    type: "response-error",
    statusCode: 200,
    error: Object.assign(new Error("marker response reset"), { code: "ECONNRESET" }),
  }, "UPSTREAM_UNREACHABLE"],
  ["request error", {
    type: "request-error",
    error: Object.assign(new Error("marker request reset"), { code: "ECONNRESET" }),
  }, "UPSTREAM_UNREACHABLE"],
  ["response abort", { type: "response-aborted", statusCode: 200 }, "UPSTREAM_UNREACHABLE"],
  ["overflow", { statusCode: 200, chunks: [Buffer.alloc(65_537)] }, "UPSTREAM_SCHEMA_UNRECOGNIZED"],
]) {
  test(`${label} clears its one fixed wall-clock timer`, async (t) => {
    const timer = installTimerHarness(t);
    const fake = createHttpsHarness([scenario]);
    const outcome = requestLovartModeQuery({
      accessKey: "a",
      secretKey: "s",
      requestImpl: fake.request,
    });
    if (expectedCode) await assert.rejects(outcome, (error) => error.code === expectedCode);
    else await outcome;
    timer.assertSingleFixedTimerCleared();
    assert.equal(fake.calls.length, 1);
  });
}

test("a fired timeout clears its timer while destroying one request", async (t) => {
  const timer = installTimerHarness(t);
  const fake = createHttpsHarness([{ type: "pending" }]);
  const outcome = requestLovartModeQuery({
    accessKey: "a",
    secretKey: "s",
    requestImpl: fake.request,
  });
  timer.fire();
  await assert.rejects(outcome, (error) => error.code === "UPSTREAM_UNREACHABLE");
  timer.assertSingleFixedTimerCleared();
  assert.equal(fake.calls.length, 1);
  assert.equal(fake.calls[0].destroyCalls, 1);
});

test("a synchronous requestImpl throw is redacted and clears the fixed timer", async (t) => {
  const timer = installTimerHarness(t);
  let calls = 0;
  await assert.rejects(
    requestLovartModeQuery({
      accessKey: "marker-access",
      secretKey: "marker-secret",
      requestImpl: () => {
        calls += 1;
        throw Object.assign(new Error("marker-access marker-secret sync request"), { code: "ENOTFOUND" });
      },
    }),
    (error) => {
      assert.equal(error.code, "UPSTREAM_UNREACHABLE");
      assertRedacted(error, ["marker-access", "marker-secret", "sync request"]);
      return true;
    },
  );
  assert.equal(calls, 1);
  timer.assertSingleFixedTimerCleared();
});

for (const type of ["write-throw", "end-throw"]) {
  test(`a synchronous ${type} failure is redacted, destroyed, and clears the timer`, async (t) => {
    const timer = installTimerHarness(t);
    const fake = createHttpsHarness([{
      type,
      error: Object.assign(new Error(`marker-access marker-secret ${type}`), { code: "ECONNRESET" }),
    }]);
    await assert.rejects(
      requestLovartModeQuery({
        accessKey: "marker-access",
        secretKey: "marker-secret",
        requestImpl: fake.request,
      }),
      (error) => {
        assert.equal(error.code, "UPSTREAM_UNREACHABLE");
        assertRedacted(error, ["marker-access", "marker-secret", type]);
        return true;
      },
    );
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].destroyCalls, 1);
    timer.assertSingleFixedTimerCleared();
  });
}

for (const [type, event] of [["response-error", "error"], ["response-aborted", "aborted"]]) {
  test(`a response ${event} settles once, destroys both streams, and clears the timer`, async (t) => {
    const timer = installTimerHarness(t);
    const fake = createHttpsHarness([{
      type,
      statusCode: 200,
      error: Object.assign(new Error("marker response failure"), { code: "ECONNRESET" }),
    }]);
    let settlements = 0;
    const outcome = requestLovartModeQuery({
      accessKey: "a",
      secretKey: "s",
      requestImpl: fake.request,
    });
    outcome.then(() => { settlements += 1; }, () => { settlements += 1; });
    await assert.rejects(outcome, (error) => error.code === "UPSTREAM_UNREACHABLE");
    await Promise.resolve();
    assert.equal(settlements, 1);
    assert.equal(fake.calls.length, 1);
    assert.equal(fake.calls[0].destroyCalls, 1);
    assert.equal(fake.calls[0].responseDestroyed, true);
    timer.assertSingleFixedTimerCleared();
  });
}

test("synchronous response settlement skips request listeners, write, and end", async (t) => {
  const timer = installTimerHarness(t);
  const response = new EventEmitter();
  response.statusCode = 200;
  let responseDestroyCalls = 0;
  response.destroy = () => { responseDestroyCalls += 1; };
  const operations = { destroy: 0, end: 0, once: 0, write: 0 };
  const request = {
    destroy() { operations.destroy += 1; },
    end() { operations.end += 1; },
    once() { operations.once += 1; },
    write() { operations.write += 1; },
  };
  let requestCalls = 0;

  const result = await requestLovartModeQuery({
    accessKey: "a",
    secretKey: "s",
    requestImpl: (_options, onResponse) => {
      requestCalls += 1;
      onResponse(response);
      response.emit("data", Buffer.from('{"sync":true}'));
      response.emit("end");
      return request;
    },
  });

  assert.deepEqual(result, { sync: true });
  assert.equal(requestCalls, 1);
  assert.deepEqual(operations, { destroy: 1, end: 0, once: 0, write: 0 });
  assert.equal(responseDestroyCalls, 0);
  timer.assertSingleFixedTimerCleared();
});

test("a response arriving after timeout is destroyed without listeners or a second settlement", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const request = new EventEmitter();
  let requestDestroyCalls = 0;
  request.write = () => {};
  request.end = () => {};
  request.destroy = (error) => {
    requestDestroyCalls += 1;
    request.emit("error", error);
  };
  let onResponse;
  let settlements = 0;
  const outcome = requestLovartModeQuery({
    accessKey: "a",
    secretKey: "s",
    requestImpl: (_options, callback) => {
      onResponse = callback;
      return request;
    },
  });
  outcome.then(() => { settlements += 1; }, () => { settlements += 1; });

  t.mock.timers.tick(8_000);
  await assert.rejects(outcome, (error) => error.code === "UPSTREAM_UNREACHABLE");

  const lateResponse = new EventEmitter();
  lateResponse.statusCode = 200;
  let lateDestroyCalls = 0;
  lateResponse.destroy = () => { lateDestroyCalls += 1; };
  onResponse(lateResponse);
  lateResponse.emit("data", Buffer.from('{"late":true}'));
  lateResponse.emit("end");
  await Promise.resolve();

  assert.equal(settlements, 1);
  assert.equal(requestDestroyCalls, 1);
  assert.equal(lateDestroyCalls, 1);
  assert.equal(lateResponse.eventNames().length, 0);
});

test("a response larger than 65,536 bytes is rejected and destroyed", async () => {
  const call = await assertFailure({
    scenario: { statusCode: 200, chunks: [Buffer.alloc(65_536), Buffer.from("x")] },
    code: "UPSTREAM_SCHEMA_UNRECOGNIZED",
  });
  assert.equal(call.destroyed, true);
  assert.equal(call.responseDestroyed, true);
});

test("a valid JSON object of exactly 65,536 bytes is accepted", async () => {
  const body = `{"x":"${"a".repeat(65_528)}"}`;
  assert.equal(Buffer.byteLength(body), 65_536);
  const fake = createHttpsHarness([{ statusCode: 200, chunks: [body.slice(0, 40_000), body.slice(40_000)] }]);

  const result = await requestLovartModeQuery({
    accessKey: "a",
    secretKey: "s",
    requestImpl: fake.request,
  });

  assert.equal(result.x.length, 65_528);
  assert.equal(fake.calls.length, 1);
});

const invalidBodies = [
  ["malformed JSON", Buffer.from("marker-not-json")],
  ["an array root", Buffer.from("[]")],
  ["a null root", Buffer.from("null")],
  ["a string root", Buffer.from('"scalar"')],
  ["a number root", Buffer.from("42")],
  ["a boolean root", Buffer.from("true")],
  ["an invalid UTF-8 sequence", Buffer.from([0xc3, 0x28])],
];

for (const [label, body] of invalidBodies) {
  test(`${label} maps to a stable schema failure`, async () => {
    await assertFailure({
      scenario: { statusCode: 200, chunks: [body] },
      code: "UPSTREAM_SCHEMA_UNRECOGNIZED",
      markers: ["marker-not-json"],
    });
  });
}
