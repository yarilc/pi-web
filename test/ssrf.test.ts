import { test } from "node:test";
import assert from "node:assert/strict";

import { isDisallowedIp } from "../src/ssrf.ts";
import { safeFetchText } from "../src/net.ts";

test("isDisallowedIp blocks RFC1918 private IPv4 ranges", () => {
	assert.equal(isDisallowedIp("10.0.0.1"), true);
	assert.equal(isDisallowedIp("10.255.255.255"), true);
	assert.equal(isDisallowedIp("172.16.0.1"), true);
	assert.equal(isDisallowedIp("172.31.255.254"), true);
	assert.equal(isDisallowedIp("192.168.1.1"), true);
	assert.equal(isDisallowedIp("192.168.0.0"), true);
});

test("isDisallowedIp blocks loopback, link-local, this-network, CGNAT", () => {
	assert.equal(isDisallowedIp("127.0.0.1"), true);
	assert.equal(isDisallowedIp("127.255.255.255"), true);
	assert.equal(isDisallowedIp("169.254.169.254"), true); // cloud metadata
	assert.equal(isDisallowedIp("0.0.0.0"), true);
	assert.equal(isDisallowedIp("100.64.0.1"), true); // CGNAT
});

test("isDisallowedIp blocks multicast/reserved/TEST-NET IPv4", () => {
	assert.equal(isDisallowedIp("224.0.0.1"), true); // multicast
	assert.equal(isDisallowedIp("240.0.0.1"), true); // reserved
	assert.equal(isDisallowedIp("255.255.255.255"), true); // broadcast
	assert.equal(isDisallowedIp("203.0.113.1"), true); // TEST-NET-3
	assert.equal(isDisallowedIp("198.51.100.1"), true); // TEST-NET-2
});

test("isDisallowedIp allows public IPv4", () => {
	assert.equal(isDisallowedIp("8.8.8.8"), false);
	assert.equal(isDisallowedIp("1.1.1.1"), false);
	assert.equal(isDisallowedIp("93.184.216.34"), false);
	// Just outside the 172.16/12 private range:
	assert.equal(isDisallowedIp("172.15.0.1"), false);
	assert.equal(isDisallowedIp("172.32.0.1"), false);
});

test("isDisallowedIp blocks IPv6 loopback/ULA/link-local/multicast", () => {
	assert.equal(isDisallowedIp("::1"), true);
	assert.equal(isDisallowedIp("::"), true); // unspecified
	assert.equal(isDisallowedIp("fc00::1"), true);
	assert.equal(isDisallowedIp("fd12:3456:789a::1"), true);
	assert.equal(isDisallowedIp("fe80::1"), true);
	assert.equal(isDisallowedIp("ff02::1"), true); // multicast
	assert.equal(isDisallowedIp("2001:db8::1"), true); // documentation
});

test("isDisallowedIp blocks IPv4-mapped private IPv6", () => {
	assert.equal(isDisallowedIp("::ffff:127.0.0.1"), true);
	assert.equal(isDisallowedIp("::ffff:10.0.0.1"), true);
	assert.equal(isDisallowedIp("::ffff:192.168.1.1"), true);
	assert.equal(isDisallowedIp("::ffff:169.254.169.254"), true);
});

test("isDisallowedIp allows public IPv6 (including IPv4-mapped public)", () => {
	assert.equal(isDisallowedIp("2606:4700:4700::1111"), false); // Cloudflare
	assert.equal(isDisallowedIp("2a00:1450:4009::93"), false); // Google
	assert.equal(isDisallowedIp("::ffff:8.8.8.8"), false); // mapped public
});

test("isDisallowedIp fails closed on non-IP garbage", () => {
	assert.equal(isDisallowedIp("not-an-ip"), true);
	assert.equal(isDisallowedIp(""), true);
	assert.equal(isDisallowedIp("example.com"), true);
});

// Integration-level SSRF guard: safeFetchText must reject disallowed hosts
// by resolving the hostname and checking every resolved address, throwing
// BEFORE opening any socket. These tests touch no network: the guard runs
// during URL validation, before the fetch begins. Running them under
// --network=none confirms the guard does not depend on a refused connection
// to fail (defense against a regression that would let the request through
// when the host happens to be reachable).
test("safeFetchText refuses a loopback IPv4 before connecting", async () => {
	await assert.rejects(
		() => safeFetchText("http://127.0.0.1/", { timeoutMs: 5_000 }),
		(err: unknown) => /refused|private|loopback|disallow|ssrf/i.test(String((err as Error)?.message ?? err)),
	);
});

test("safeFetchText refuses a private RFC1918 IPv4 before connecting", async () => {
	await assert.rejects(
		() => safeFetchText("http://10.0.0.1/", { timeoutMs: 5_000 }),
		(err: unknown) => /refused|private|loopback|disallow|ssrf/i.test(String((err as Error)?.message ?? err)),
	);
});

test("safeFetchText refuses cloud metadata address before connecting", async () => {
	// 169.254.169.254 is the AWS/GCP/Azure metadata endpoint; blocking it is
	// critical to prevent the agent from leaking instance credentials.
	await assert.rejects(
		() => safeFetchText("http://169.254.169.254/latest/meta-data/", { timeoutMs: 5_000 }),
		(err: unknown) => /refused|private|loopback|disallow|ssrf/i.test(String((err as Error)?.message ?? err)),
	);
});
