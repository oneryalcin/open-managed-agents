import { describe, expect, it } from "vitest";
import { convertWebDocument } from "../convert.ts";

// Plan 0149 slice 1b: fetched bytes to the text the model sees. HTML goes
// through turndown in an isolated worker with memory, deadline and abort
// limits; text and JSON pass through.

const bytes = (text: string) => new TextEncoder().encode(text);

describe("web document conversion", () => {
  it("converts HTML to text and takes the title from <title>", async () => {
    const html = `<html><head><title>Guide</title><style>p{}</style></head>
      <body><nav>menu</nav><h1>Install</h1><p>Run <code>npm i</code>.</p><script>x()</script></body></html>`;

    const result = await convertWebDocument(bytes(html), "text/html; charset=utf-8");

    expect(result.ok && [result.title, result.text]).toEqual(["Guide", "# Install\n\nRun `npm i`."]);
  });

  it("collapses whitespace in the title", async () => {
    const html = "<html><head><title>  A\n  spaced   title </title></head><body><p>x</p></body></html>";

    const result = await convertWebDocument(bytes(html), "text/html");

    expect(result.ok && result.title).toBe("A spaced title");
  });

  it("passes plain text through unchanged", async () => {
    const result = await convertWebDocument(bytes("line 1\nline 2"), "text/plain");

    expect(result.ok && result.text).toBe("line 1\nline 2");
  });

  it("passes JSON through unchanged", async () => {
    const result = await convertWebDocument(bytes('{"a":1}'), "application/json");

    expect(result.ok && result.text).toBe('{"a":1}');
  });

  it("refuses media it cannot turn into text", async () => {
    const result = await convertWebDocument(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/png");

    expect(result.ok ? "ok" : result.code).toBe("unsupported_media");
  });

  it("decodes the charset named in Content-Type", async () => {
    const latin1 = new Uint8Array([0x63, 0x61, 0x66, 0xe9]); // "café" in latin-1

    const result = await convertWebDocument(latin1, "text/plain; charset=iso-8859-1");

    expect(result.ok && result.text).toBe("café");
  });

  it("decodes the charset named in an HTML meta tag", async () => {
    const head = bytes('<html><head><meta charset="iso-8859-1"></head><body><p>caf');
    const html = new Uint8Array([...head, 0xe9, ...bytes("</p></body></html>")]);

    const result = await convertWebDocument(html, "text/html");

    expect(result.ok && result.text).toBe("café");
  });

  it("cuts long text at the character cap and says so", async () => {
    const result = await convertWebDocument(bytes("x".repeat(500)), "text/plain", { maxChars: 100 });

    expect(result.ok && [result.text.length, result.truncated]).toEqual([100, true]);
  });

  it("caps converted HTML that expands far beyond its size", async () => {
    // Nested blockquotes: each level prefixes every line, so a small page
    // becomes megabytes of text. The cap is applied inside the worker.
    const html = "<blockquote>".repeat(300) + "<p>line</p>".repeat(50) + "</blockquote>".repeat(300);

    const result = await convertWebDocument(bytes(html), "text/html", { maxChars: 100 });

    expect(result.ok && [result.text.length <= 100, result.truncated]).toEqual([true, true]);
  });

  it("gives up on a page that takes too long to convert", async () => {
    // A nesting bomb: small, but turndown recurses through every level.
    const bomb = `<div>`.repeat(50_000) + "x" + `</div>`.repeat(50_000);

    const result = await convertWebDocument(bytes(bomb), "text/html", { deadlineMs: 300 });

    expect(result.ok ? "ok" : result.code).toBe("timeout");
  });

  it("stops converting when the caller aborts", async () => {
    const bomb = `<div>`.repeat(50_000) + "x" + `</div>`.repeat(50_000);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);

    const result = await convertWebDocument(bytes(bomb), "text/html", { signal: controller.signal });

    expect(result.ok ? "ok" : result.code).toBe("aborted");
  });

  it("keeps title extraction inside the deadline", async () => {
    // Repeated unclosed <title> tags made a main-thread regex quadratic.
    const html = "<title>".repeat(40_000) + "<p>x</p>";
    const started = performance.now();

    await convertWebDocument(bytes(html), "text/html", { deadlineMs: 500 });

    expect(performance.now() - started).toBeLessThan(1_500);
  });

  it("stops a queued conversion when the caller aborts", async () => {
    const bomb = bytes(`<div>`.repeat(50_000) + "x" + `</div>`.repeat(50_000));
    const busy = [1, 2].map(() => convertWebDocument(bomb, "text/html", { deadlineMs: 2_000 }));
    const controller = new AbortController();
    const queued = convertWebDocument(bytes("<p>late</p>"), "text/html", { signal: controller.signal });
    setTimeout(() => controller.abort(), 50);
    const started = performance.now();

    const result = await queued;

    expect([result.ok ? "ok" : result.code, performance.now() - started < 1_000]).toEqual(["aborted", true]);
    await Promise.all(busy);
  });

  it("counts time spent queued against the deadline", async () => {
    const bomb = bytes(`<div>`.repeat(50_000) + "x" + `</div>`.repeat(50_000));
    const busy = [1, 2].map(() => convertWebDocument(bomb, "text/html", { deadlineMs: 2_000 }));

    const result = await convertWebDocument(bytes("<p>late</p>"), "text/html", { deadlineMs: 200 });

    expect(result.ok ? "ok" : result.code).toBe("timeout");
    await Promise.all(busy);
  });
});
