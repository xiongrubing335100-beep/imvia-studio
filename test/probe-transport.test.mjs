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
    };
    calls.push(call);

    requestEmitter.write = (chunk) => {
      call.body += String(chunk);
    };
    requestEmitter.end = () => {
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

        for (const chunk of scenario?.chunks ?? [scenario?.body ?? "{}"])
          response.emit("data", chunk);
        response.emit("end");
      });
    };
    requestEmitter.destroy = (error) => {
      call.destroyed = true;
      call.destroyError = error;
      requestEmitter.emit("error", error);
    };

    return requestEmitter;
  }

  return { calls, request };
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
    assert.equal("agent" in fake.calls[0].options, false);
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

for (const tlsCode of ["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID"]) {
  test(`${tlsCode} maps to a redacted TLS security failure`, async () => {
    const error = Object.assign(new Error(`TLS marker-upstream ${tlsCode}`), { code: tlsCode });
    await assertFailure({
      scenario: { type: "request-error", error },
      code: "UPSTREAM_SECURITY_REJECTED",
      markers: ["marker-upstream", tlsCode],
    });
  });
}

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
