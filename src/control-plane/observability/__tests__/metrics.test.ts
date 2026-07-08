// Plan 0121 §5: the hand-rolled registry's insurance is a STRICT exposition
// parser — the wire format is validated structurally, not by substring
// spot-checks (§9 Opus M1: the escaping footgun is prevented by closed-enum
// labels; these tests prove the rest of the format).
import { describe, expect, it } from "vitest";
import { createControlPlaneMetrics } from "../instruments.ts";
import { EXPOSITION_CONTENT_TYPE, MetricsRegistry } from "../metrics.ts";

interface ParsedSample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

// Strict subset of the Prometheus text format (version 0.0.4): every sample
// line must parse, every samples-bearing metric must have HELP+TYPE first,
// label values must not contain unescaped quotes/newlines/backslashes.
function parseExposition(text: string): {
  samples: ParsedSample[];
  types: Map<string, string>;
} {
  const samples: ParsedSample[] = [];
  const types = new Map<string, string>();
  const helps = new Set<string>();
  expect(text.endsWith("\n")).toBe(true);
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const help = line.match(/^# HELP ([a-zA-Z_:][a-zA-Z0-9_:]*) (.+)$/);
    if (help) {
      helps.add(help[1]!);
      continue;
    }
    const type = line.match(
      /^# TYPE ([a-zA-Z_:][a-zA-Z0-9_:]*) (counter|gauge|histogram)$/,
    );
    if (type) {
      expect(helps.has(type[1]!)).toBe(true);
      types.set(type[1]!, type[2]!);
      continue;
    }
    expect(line.startsWith("#")).toBe(false);
    const sample = line.match(
      /^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{([^}]*)\})? (-?\d+(\.\d+)?(e[+-]?\d+)?|NaN|[+-]Inf)$/,
    );
    expect(sample, `unparseable sample line: ${JSON.stringify(line)}`).toBeTruthy();
    const labels: Record<string, string> = {};
    if (sample![3]) {
      for (const pair of sample![3].split(",")) {
        const kv = pair.match(/^([a-zA-Z_][a-zA-Z0-9_]*)="([^"\\\n]*)"$/);
        expect(kv, `bad label pair: ${JSON.stringify(pair)}`).toBeTruthy();
        labels[kv![1]!] = kv![2]!;
      }
    }
    samples.push({
      name: sample![1]!,
      labels,
      value: sample![4] === "NaN" ? Number.NaN : Number(sample![4]),
    });
  }
  return { samples, types };
}

function sample(
  samples: ParsedSample[],
  name: string,
  labels: Record<string, string> = {},
): ParsedSample | undefined {
  return samples.find(
    (s) =>
      s.name === name &&
      Object.keys(labels).length === Object.keys(s.labels).length &&
      Object.entries(labels).every(([k, v]) => s.labels[k] === v),
  );
}

describe("metrics registry", () => {
  it("renders labeled counters through the strict parser", () => {
    const registry = new MetricsRegistry();
    const requests = registry.counter("oma_test_requests_total", "Requests.", {
      route_class: ["v1", "admin", "other"],
      status: ["200", "500", "other"],
    });
    requests.inc({ route_class: "v1", status: "200" });
    requests.inc({ route_class: "v1", status: "200" });
    requests.inc({ route_class: "admin", status: "500" });
    const { samples, types } = parseExposition(registry.exposition());
    expect(types.get("oma_test_requests_total")).toBe("counter");
    expect(
      sample(samples, "oma_test_requests_total", { route_class: "v1", status: "200" })
        ?.value,
    ).toBe(2);
    expect(
      sample(samples, "oma_test_requests_total", { route_class: "admin", status: "500" })
        ?.value,
    ).toBe(1);
  });

  it("routes undeclared label values to other and stays parseable", () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter("oma_test_hostile_total", "Hostile.", {
      method: ["GET", "other"],
    });
    counter.inc({ method: 'EVIL"} injected{x="' });
    counter.inc({ method: "GET\nfake_metric 999" });
    counter.inc();
    const { samples } = parseExposition(registry.exposition());
    expect(sample(samples, "oma_test_hostile_total", { method: "other" })?.value).toBe(3);
    expect(registry.exposition()).not.toContain("EVIL");
    expect(registry.exposition()).not.toContain("fake_metric");
  });

  it("exposes MCP authentication failures as a distinct connection outcome", () => {
    const instruments = createControlPlaneMetrics();
    instruments.mcpConnections.inc({ event: "auth_failed" });

    const { samples } = parseExposition(instruments.registry.exposition());
    expect(
      sample(samples, "oma_mcp_connections_total", { event: "auth_failed" })?.value,
    ).toBe(1);
  });

  it("accounts histogram buckets cumulatively with +Inf equal to count", () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram(
      "oma_test_duration_seconds",
      "Durations.",
      [0.1, 1, 10],
    );
    // 1 sits exactly on a bucket boundary: le is INCLUSIVE (<=), so a
    // <-vs-<= mutant moves it to the next bucket and fails this test.
    for (const v of [0.05, 0.05, 1, 5, 50]) histogram.observe(v);
    const { samples, types } = parseExposition(registry.exposition());
    expect(types.get("oma_test_duration_seconds")).toBe("histogram");
    // Exact cumulative accounting — pins the bucket math against mutants.
    expect(sample(samples, "oma_test_duration_seconds_bucket", { le: "0.1" })?.value).toBe(2);
    expect(sample(samples, "oma_test_duration_seconds_bucket", { le: "1" })?.value).toBe(3);
    expect(sample(samples, "oma_test_duration_seconds_bucket", { le: "10" })?.value).toBe(4);
    expect(sample(samples, "oma_test_duration_seconds_bucket", { le: "+Inf" })?.value).toBe(5);
    expect(sample(samples, "oma_test_duration_seconds_count")?.value).toBe(5);
    expect(sample(samples, "oma_test_duration_seconds_sum")?.value).toBeCloseTo(56.1);
  });

  it("histograms keep per-label-value series apart", () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram("oma_test_by_class_seconds", "By class.", [1], {
      route_class: ["v1", "other"],
    });
    histogram.observe(0.5, { route_class: "v1" });
    histogram.observe(2, { route_class: "nonsense" });
    const { samples } = parseExposition(registry.exposition());
    expect(
      sample(samples, "oma_test_by_class_seconds_bucket", { route_class: "v1", le: "1" })
        ?.value,
    ).toBe(1);
    expect(
      sample(samples, "oma_test_by_class_seconds_count", { route_class: "other" })?.value,
    ).toBe(1);
  });

  it("gauges collect at scrape time and survive a throwing collector", () => {
    const registry = new MetricsRegistry();
    let live = 3;
    registry.gauge("oma_test_live", "Live things.", () => live);
    registry.gauge("oma_test_broken", "Broken collector.", () => {
      throw new Error("collector exploded");
    });
    live = 7;
    const { samples } = parseExposition(registry.exposition());
    expect(sample(samples, "oma_test_live")?.value).toBe(7);
    expect(sample(samples, "oma_test_broken")?.value).toBeNaN();
  });

  it("refuses duplicate metric names", () => {
    const registry = new MetricsRegistry();
    registry.counter("oma_test_dup_total", "First.");
    expect(() => registry.counter("oma_test_dup_total", "Second.")).toThrow(
      /already registered/,
    );
  });

  it("exposes the Prometheus text content type", () => {
    expect(EXPOSITION_CONTENT_TYPE).toBe("text/plain; version=0.0.4; charset=utf-8");
  });
});
