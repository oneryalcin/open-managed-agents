// Headless browser smoke for plan 0125: drive the REAL no-build console
// (Babel-transpiled JSX, vendored React) served by the live appliance, in
// demo mode. Targets the shipped regression: Validate was a no-op because the
// ConfirmDialog rendered only in the list branch.
//
// Setup / run:
//   OMA_PORT=4199 OMA_SANDBOX_PROVIDER=none \
//     node --experimental-transform-types src/main.ts &   # boot appliance
//   npm i --no-save puppeteer-core                        # uses system Chrome
//   node scratch/55-console-vaults-smoke.mjs              # exit 0 = pass
//
// SCOPE (honest): demo mode exercises the exact JSX render + confirm-dialog +
// result-panel path the bug broke, with zero live network. It does NOT cover
// the live-API POST (validateMcpOauthCredential) nor the admin credential-health
// view — those still need a human/deployment pass per the plan's manual smoke.
// Last run 2026-07-10: PASS (nav → open vault → Validate → dialog → confirm →
// "valid | Credential works."), only a benign /favicon.ico 404, no JS errors.
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://127.0.0.1:4199/console/?mode=demo";
const log = (...a) => console.log(...a);

const browser = await puppeteer.launch({ executablePath: CHROME, headless: "new", args: ["--no-sandbox"] });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

await page.goto(BASE, { waitUntil: "networkidle0" });
await new Promise((r) => setTimeout(r, 1200)); // Babel transpile + first render

// 1. Navigate to Vaults via the sidebar nav.
const clickedNav = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".nav-item")].find((n) => /vault/i.test(n.textContent));
  if (el) { el.click(); return true; }
  return false;
});
log("nav Vaults clicked:", clickedNav);
await new Promise((r) => setTimeout(r, 600));

// 2. Open the demo vault (first row).
const openedVault = await page.evaluate(() => {
  const row = document.querySelector(".panel .trow");
  if (row) { row.click(); return row.textContent.trim().slice(0, 40); }
  return null;
});
log("opened vault row:", openedVault);
await new Promise((r) => setTimeout(r, 600));

// 3. Click Validate on the demo credential.
const clickedValidate = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => /validate/i.test(b.textContent));
  if (btn) { btn.click(); return true; }
  return false;
});
log("Validate button clicked:", clickedValidate);
await new Promise((r) => setTimeout(r, 400));

// 4. THE REGRESSION CHECK: the ConfirmDialog must now be present.
const dialogText = await page.evaluate(() => {
  const dlg = [...document.querySelectorAll("*")].find((e) => /contacts the MCP server/i.test(e.textContent) && e.querySelector("button"));
  return dlg ? "dialog-present" : "dialog-MISSING";
});
log("confirm dialog:", dialogText);

// 5. Confirm, then assert the result panel renders the canned demo outcome.
const confirmed = await page.evaluate(() => {
  const btn = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === "Validate" && b.closest(".modal, .dialog, [class*=modal]"));
  const anyConfirm = btn || [...document.querySelectorAll("button")].filter((b) => b.textContent.trim() === "Validate").pop();
  if (anyConfirm) { anyConfirm.click(); return true; }
  return false;
});
await new Promise((r) => setTimeout(r, 500));
const resultText = await page.evaluate(() => {
  const el = [...document.querySelectorAll(".panel b, .badge")].map((e) => e.textContent).join(" | ");
  return el;
});
log("confirm clicked:", confirmed);
log("result panel text:", resultText);

const validatePass = clickedNav && openedVault && clickedValidate && dialogText === "dialog-present" && /works|valid/i.test(resultText);
log("\nSMOKE:", validatePass ? "PASS — Validate flow reaches dialog + result" : "FAIL");
log("page errors:", errors.length ? errors : "none");
await browser.close();
process.exit(validatePass && errors.length === 0 ? 0 : 1);
