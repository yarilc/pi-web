/**
 * SSRF protection helpers for the pi-web tools.
 *
 * These guards prevent the web tools from trivially reaching private,
 * loopback, link-local, cloud-metadata, or otherwise non-public network
 * addresses. They are defense-in-depth, NOT a security sandbox: an attacker
 * who controls the requested hostname may still attempt DNS rebinding (the
 * resolved address can change between the check here and the real connection).
 * Treat this as a footgun reducer, not a trust boundary.
 *
 * Set the environment variable `PI_WEB_ALLOW_PRIVATE=1` (or `true`) to opt out,
 * for example to fetch internal documentation from a private network.
 */
import { isIPv4, isIPv6 } from "node:net";

/** Build an unsigned 32-bit IPv4 integer from four octets. Keeps range tables readable. */
function octets(o1: number, o2: number, o3: number, o4: number): number {
	return (((o1 * 256 + o2) * 256 + o3) * 256 + o4) >>> 0;
}

/** Blocked IPv4 ranges as inclusive [start, end] pairs (32-bit unsigned). */
const IPV4_BLOCKED: ReadonlyArray<readonly [number, number]> = [
	[octets(0, 0, 0, 0), octets(0, 255, 255, 255)], // 0.0.0.0/8 "this network"
	[octets(10, 0, 0, 0), octets(10, 255, 255, 255)], // 10.0.0.0/8 RFC1918 private
	[octets(100, 64, 0, 0), octets(100, 127, 255, 255)], // 100.64.0.0/10 CGNAT
	[octets(127, 0, 0, 0), octets(127, 255, 255, 255)], // 127.0.0.0/8 loopback
	[octets(169, 254, 0, 0), octets(169, 254, 255, 255)], // 169.254.0.0/16 link-local (+ cloud metadata)
	[octets(172, 16, 0, 0), octets(172, 31, 255, 255)], // 172.16.0.0/12 RFC1918 private
	[octets(192, 0, 0, 0), octets(192, 0, 0, 255)], // 192.0.0.0/24 IETF protocol assignments
	[octets(192, 0, 2, 0), octets(192, 0, 2, 255)], // 192.0.2.0/24 TEST-NET-1
	[octets(192, 168, 0, 0), octets(192, 168, 255, 255)], // 192.168.0.0/16 RFC1918 private
	[octets(198, 18, 0, 0), octets(198, 19, 255, 255)], // 198.18.0.0/15 benchmarking
	[octets(198, 51, 100, 0), octets(198, 51, 100, 255)], // 198.51.100.0/24 TEST-NET-2
	[octets(203, 0, 113, 0), octets(203, 0, 113, 255)], // 203.0.113.0/24 TEST-NET-3
	[octets(224, 0, 0, 0), octets(255, 255, 255, 255)], // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
];

/** Parse a dotted-quad IPv4 string into an unsigned 32-bit integer, or null if invalid. */
function ipv4ToLong(ip: string): number | null {
	const parts = ip.split(".");
	if (parts.length !== 4) return null;
	let n = 0;
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return null;
		const v = Number(part);
		if (v > 255) return null;
		n = n * 256 + v;
	}
	return n >>> 0;
}

/** Blocked IPv6 ranges as inclusive [start, end] pairs (128-bit BigInt). */
const IPV6_BLOCKED: ReadonlyArray<readonly [bigint, bigint]> = [
	[0n, 0n], // :: unspecified
	[1n, 1n], // ::1 loopback
	[0xfc00n << 112n, (0xfdffn << 112n) | ((1n << 112n) - 1n)], // fc00::/7 unique-local
	[0xfe80n << 112n, (0xfebfn << 112n) | ((1n << 112n) - 1n)], // fe80::/10 link-local
	[0xff00n << 112n, (0xffffn << 112n) | ((1n << 112n) - 1n)], // ff00::/8 multicast
	[0x20010db8n << 96n, (0x20010db8n << 96n) | ((1n << 96n) - 1n)], // 2001:db8::/32 documentation
];

/** Parse a single 16-bit hex group (1-4 hex digits). Returns null on invalid input. */
function parseHexGroup(g: string): number | null {
	if (g === "" || !/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
	return Number.parseInt(g, 16);
}

/** Combine eight 16-bit groups into a 128-bit BigInt (most-significant group first). */
function groupsToBigInt(groups: ReadonlyArray<number>): bigint {
	let result = 0n;
	for (const g of groups) {
		result = (result << 16n) | BigInt(g);
	}
	return result;
}

/**
 * Parse an IPv6 address (possibly with a zone id and/or an embedded IPv4 tail)
 * into a 128-bit BigInt. Returns null if the address is malformed.
 */
function ipv6ToBigInt(ip: string): bigint | null {
	const zoneStripped = ip.split("%")[0] ?? ip;
	let normalized = zoneStripped;

	// Convert a trailing IPv4 tail (e.g. ::ffff:192.0.2.1) into two 16-bit groups.
	const lastColon = zoneStripped.lastIndexOf(":");
	if (lastColon !== -1) {
		const tail = zoneStripped.slice(lastColon + 1);
		if (tail.includes(".")) {
			const ipv4 = ipv4ToLong(tail);
			if (ipv4 == null) return null;
			const hi = (ipv4 >>> 16) & 0xffff;
			const lo = ipv4 & 0xffff;
			normalized = `${zoneStripped.slice(0, lastColon + 1)}${hi.toString(16)}:${lo.toString(16)}`;
		}
	}

	const halves = normalized.split("::");
	if (halves.length > 2) return null; // at most one "::" allowed

	const headGroups: number[] = [];
	for (const g of halves[0] ? halves[0]!.split(":") : []) {
		const v = parseHexGroup(g);
		if (v == null) return null;
		headGroups.push(v);
	}

	const tailGroups: number[] = [];
	if (halves.length === 2) {
		for (const g of halves[1] ? halves[1]!.split(":") : []) {
			const v = parseHexGroup(g);
			if (v == null) return null;
			tailGroups.push(v);
		}
	}

	const total = headGroups.length + tailGroups.length;
	if (halves.length === 2) {
		// "::" form: pad with zero groups to reach 8 total.
		if (total > 8) return null;
		const fill = 8 - total;
		return groupsToBigInt([...headGroups, ...new Array(fill).fill(0), ...tailGroups]);
	}
	// Fully expanded form must have exactly 8 groups.
	if (total !== 8) return null;
	return groupsToBigInt(headGroups);
}

/** Extract the embedded IPv4 from an IPv4-mapped (::ffff:a.b.c.d) address, or null. */
function extractIpv4Mapped(n: bigint): number | null {
	const start = 0xffffn << 96n;
	const end = start | ((1n << 96n) - 1n);
	if (n >= start && n <= end) {
		return Number(n & 0xffffffffn) >>> 0;
	}
	return null;
}

/** Extract the embedded IPv4 from a deprecated IPv4-compatible (::a.b.c.d) address, or null. */
function extractIpv4Compatible(n: bigint): number | null {
	if (n > 0n && n < (1n << 96n)) {
		return Number(n & 0xffffffffn) >>> 0;
	}
	return null;
}

/**
 * Decide whether an IP literal is disallowed for fetching.
 *
 * Fails closed: an unparseable or unrecognized literal is treated as
 * disallowed, so a malformed address can never slip through to the network.
 */
export function isDisallowedIp(ip: string): boolean {
	if (isIPv4(ip)) {
		const n = ipv4ToLong(ip);
		if (n == null) return true;
		for (const [start, end] of IPV4_BLOCKED) {
			if (n >= start && n <= end) return true;
		}
		return false;
	}
	if (isIPv6(ip)) {
		const n = ipv6ToBigInt(ip);
		if (n == null) return true;
		// Check IPv6 ranges first (covers ::1 etc.) before IPv4-mapped/compat extraction.
		for (const [start, end] of IPV6_BLOCKED) {
			if (n >= start && n <= end) return true;
		}
		const mapped = extractIpv4Mapped(n) ?? extractIpv4Compatible(n);
		if (mapped != null) {
			for (const [start, end] of IPV4_BLOCKED) {
				if (mapped >= start && mapped <= end) return true;
			}
		}
		return false;
	}
	// Not a recognizable IP literal: fail closed.
	return true;
}
