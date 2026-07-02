// SSRF / private-IP egress deny (plan 0117b, ADR 0016 §5).
//
// The vendored proxy allowlists a *hostname* and then dials that hostname, so
// an allowlisted name that resolves to a private/loopback address — or that
// flips via DNS rebinding between check and connect — would reach internal
// services. The fix is connect-to-a-pinned-vetted-IP: resolve once, reject if
// ANY resolved address is in a blocked range, and hand the vetted IP to the
// socket so Node connects to exactly what we validated (no re-resolution, so no
// TOCTOU). The hostname is preserved separately as TLS SNI/servername by the
// caller. This is Node's idiomatic seam: `net`/`tls`/`https` all accept a
// `lookup` option with the `dns.lookup` signature.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import { BlockList, isIPv4 } from "node:net";

export type LookupFn = (
  hostname: string,
  options: unknown,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | LookupAddress[],
    family?: number,
  ) => void,
) => void;

// Ranges an egress target must never resolve into. Deny-by-listing the
// dangerous space (RFC1918 + loopback + link-local + ULA + CGNAT + special-use)
// rather than allow-listing public space, so a new reserved range fails closed
// only if we miss it — hence the broad reserved/multicast entries too.
function buildBlockList(): BlockList {
  const b = new BlockList();
  // IPv4
  b.addSubnet("0.0.0.0", 8, "ipv4"); // "this host"
  b.addSubnet("10.0.0.0", 8, "ipv4"); // private
  b.addSubnet("100.64.0.0", 10, "ipv4"); // CGNAT
  b.addSubnet("127.0.0.0", 8, "ipv4"); // loopback
  b.addSubnet("169.254.0.0", 16, "ipv4"); // link-local (incl. cloud metadata 169.254.169.254)
  b.addSubnet("172.16.0.0", 12, "ipv4"); // private
  b.addSubnet("192.0.0.0", 24, "ipv4"); // IETF protocol assignments
  b.addSubnet("192.0.2.0", 24, "ipv4"); // TEST-NET-1
  b.addSubnet("192.168.0.0", 16, "ipv4"); // private
  b.addSubnet("198.18.0.0", 15, "ipv4"); // benchmarking
  b.addSubnet("198.51.100.0", 24, "ipv4"); // TEST-NET-2
  b.addSubnet("203.0.113.0", 24, "ipv4"); // TEST-NET-3
  b.addSubnet("224.0.0.0", 4, "ipv4"); // multicast
  b.addSubnet("240.0.0.0", 4, "ipv4"); // reserved + 255.255.255.255
  // IPv6
  b.addAddress("::", "ipv6"); // unspecified
  b.addAddress("::1", "ipv6"); // loopback
  b.addSubnet("fc00::", 7, "ipv6"); // unique local (ULA)
  b.addSubnet("fe80::", 10, "ipv6"); // link-local
  b.addSubnet("ff00::", 8, "ipv6"); // multicast
  b.addSubnet("2001:db8::", 32, "ipv6"); // documentation
  return b;
}

const BLOCK_LIST = buildBlockList();

// An IPv4-mapped IPv6 address (::ffff:a.b.c.d) tunnels an IPv4 destination
// through an IPv6 literal; check the embedded IPv4 against the IPv4 rules so a
// mapped private address can't slip past the IPv6 checks.
function mappedIpv4(address: string): string | undefined {
  const m = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i.exec(address);
  return m ? m[1] : undefined;
}

export function isBlockedAddress(address: string, family: number): boolean {
  const mapped = mappedIpv4(address);
  if (mapped !== undefined) return BLOCK_LIST.check(mapped, "ipv4");
  return BLOCK_LIST.check(address, family === 6 ? "ipv6" : "ipv4");
}

export interface PinnedLookupOptions {
  // Escape hatch for tests that must reach a loopback fixture. NEVER set in
  // production — an allowed loopback defeats the whole control.
  allowAddress?: (address: string, family: number) => boolean;
}

// Returns a `dns.lookup`-compatible function that resolves the hostname,
// rejects the whole request if ANY resolved address is blocked (so an attacker
// mixing one public + one private A record cannot gamble on Node's choice), and
// otherwise returns the vetted address(es) for Node to connect to directly.
export function createPinnedLookup(opts: PinnedLookupOptions = {}): LookupFn {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) {
        callback(err, "", 0);
        return;
      }
      for (const a of addresses) {
        if (opts.allowAddress?.(a.address, a.family)) continue;
        if (isBlockedAddress(a.address, a.family)) {
          callback(
            Object.assign(
              new Error(
                `egress denied: ${hostname} resolves to ${a.address}, a blocked (private/loopback/reserved) range`,
              ),
              { code: "EGRESS_SSRF_BLOCKED" },
            ),
            "",
            0,
          );
          return;
        }
      }
      const wantsAll =
        typeof options === "object" && options !== null && "all" in options
          ? Boolean((options as { all?: unknown }).all)
          : false;
      if (wantsAll) {
        callback(null, addresses);
        return;
      }
      const first = addresses[0];
      callback(null, first.address, isIPv4(first.address) ? 4 : 6);
    });
  };
}
