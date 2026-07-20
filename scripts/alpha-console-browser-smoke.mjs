#!/usr/bin/env node
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "playwright-core";

const KEY_LINE = /x-api-key: (oma_[A-Za-z0-9_-]+)/;
const URL_LINE = /open-managed-agents listening on (http:\/\/[^\s]+)/;
const state = { child: undefined, browser: undefined, page: undefined, home: undefined };

try {
  const started = await startOma();
  const usePlaywrightBrowser = process.env.OMA_PLAYWRIGHT_MANAGED_BROWSER === "1";
  state.browser = await chromium.launch({
    headless: true,
    ...(usePlaywrightBrowser
      ? {}
      : process.env.OMA_BROWSER_EXECUTABLE
      ? { executablePath: process.env.OMA_BROWSER_EXECUTABLE }
      : { channel: "chrome" }),
  });
  const page = await state.browser.newPage();
  state.page = page;
  page.on("pageerror", (error) => console.error(`browser page error: ${error.stack || error.message}`));
  await page.goto(`${started.baseUrl}/console/`);

  await page.getByRole("heading", { name: "Connect" }).waitFor();
  const workspaceTier = page.locator(".tool-toggle").filter({ hasText: "Workspace key" });
  await workspaceTier.waitFor();
  if (!(await workspaceTier.getAttribute("class"))?.split(/\s+/).includes("on")) {
    throw new Error("Workspace key was not the default console login tier");
  }
  await page.locator("#console-credential-key").fill(started.apiKey);
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("heading", { name: "Start" }).waitFor();
  await page.getByText(/selectable model\(s\) report configured credentials/).waitFor();
  await page.getByText(/Sandbox execution remains unverified until a session runs a tool/).waitFor();

  await page.getByRole("button", { name: "Create agent" }).click();
  let dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Create agent" }).waitFor();
  await dialog.locator("#create-agent-name").fill("alpha-browser-agent");
  await dialog.getByRole("radio", { name:/Allow automatically/ }).click();
  await dialog.getByRole("button", { name: "Create agent" }).click();
  await page.getByRole("heading", { name: "alpha-browser-agent" }).waitFor();
  await page.locator("#agent-tool-approval").waitFor();
  if (await page.locator("#agent-tool-approval").inputValue() !== "always_allow") {
    throw new Error("Created agent did not preserve automatic tool approval");
  }
  await page.locator("#agent-tool-approval").selectOption("always_ask");
  await page.getByRole("button", { name:"Save new version" }).click();
  await page.getByText("v2", { exact:true }).waitFor();

  await page.getByText("Start", { exact: true }).first().click();
  await page.getByRole("button", { name: "Create environment" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Create environment" }).waitFor();
  await dialog.locator("#create-environment-name").fill("alpha-browser-environment");
  await dialog.getByRole("button", { name: "Create environment" }).click();
  await page.getByText("alpha-browser-environment", { exact: true }).waitFor();

  await page.getByText("Start", { exact: true }).first().click();
  await page.getByRole("button", { name: "Create session" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("heading", { name: "Create session" }).waitFor();
  await dialog.getByRole("button", { name: "Create session" }).click();
  await page.waitForURL(/#session=/);
  await page.getByRole("button", { name:"Actions" }).click();
  await page.getByText("Archive session", { exact:true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name:"Archive session" }).click();
  await page.getByPlaceholder("Archived sessions are read-only.").waitFor();
  if (!(await page.getByRole("button", { name:"Ask Claude" }).isDisabled())) {
    throw new Error("Archived session kept Ask Claude enabled");
  }

  await page.getByRole("button", { name:"Actions" }).click();
  await page.getByText("Delete session", { exact:true }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name:"Delete session" }).click();
  await page.getByRole("heading", { name:"Sessions", exact:true }).waitFor();

  await page.getByText("Agents", { exact:true }).first().click();
  await page.getByText("alpha-browser-agent", { exact:true }).click();
  await page.getByRole("button", { name:"Archive" }).click();
  dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name:"Archive agent" }).click();
  await page.getByText("Archived", { exact:true }).first().waitFor();
  if (!(await page.getByRole("button", { name:"Create session" }).isDisabled())) {
    throw new Error("Archived agent kept Create session enabled");
  }
  if ((await page.locator("body").innerText()).includes("Demo data")) {
    throw new Error("Console browser smoke observed demo fallback text");
  }
  console.log("Alpha console browser smoke passed: login, permission revision, session archive/delete, and agent archive gating.");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  if (state.page) {
    console.error(`Visible console text:\n${(await state.page.locator("body").innerText().catch(() => "(unavailable)" )).slice(0, 4_000)}`);
  }
  process.exitCode = 1;
} finally {
  await state.browser?.close().catch(() => {});
  if (state.child && state.child.exitCode === null) {
    state.child.kill("SIGTERM");
    await Promise.race([
      new Promise((resolve) => state.child.once("exit", resolve)),
      delay(5_000),
    ]);
    if (state.child.exitCode === null) state.child.kill("SIGKILL");
  }
  if (state.home) await rm(state.home, { recursive: true, force: true });
}

async function startOma() {
  state.home = await mkdtemp(join(tmpdir(), "oma-alpha-browser-"));
  await chmod(state.home, 0o700);
  const child = spawn(process.execPath, ["bin/oma.mjs", "up", "--sandbox", "docker"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      OMA_HOME: state.home,
      OMA_HOST: "127.0.0.1",
      OMA_PORT: "0",
      ANTHROPIC_API_KEY: "alpha-browser-placeholder-not-used-for-model-requests",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  state.child = child;
  let logs = "";
  let baseUrl;
  let apiKey;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    logs += chunk;
    baseUrl ??= URL_LINE.exec(logs)?.[1];
    apiKey ??= KEY_LINE.exec(logs)?.[1];
  });
  child.stderr.on("data", (chunk) => { logs += chunk; });
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`OMA exited during browser-smoke startup.\n${logs.trim()}`);
    if (baseUrl && apiKey) return { baseUrl, apiKey };
    await delay(100);
  }
  throw new Error(`Timed out waiting for OMA browser-smoke startup.\n${logs.trim()}`);
}
