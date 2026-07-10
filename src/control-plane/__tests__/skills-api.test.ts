import { File } from "node:buffer";
import { describe, expect, it } from "vitest";
import { createInMemoryControlPlaneApp } from "./helpers.ts";
import { MAX_SKILLS_UPLOAD_REQUEST_BYTES } from "../skills/routes.ts";
import { MAX_SKILL_FILES } from "../skills/types.ts";

describe("skills API", () => {
  it("creates, versions, lists, retrieves, and deletes a custom skill", async () => {
    const app = createInMemoryControlPlaneApp();
    const created = await createSkill(app, "demo-skill", "first");
    expect(created).toMatchObject({ id: expect.stringMatching(/^skill_/), type: "skill", source: "custom", display_title: "demo-skill", latest_version: expect.stringMatching(/^\d{16}$/) });
    const firstVersion = await json(app.request(`/v1/skills/${created.id}/versions/latest`));
    expect(firstVersion).toMatchObject({ id: expect.stringMatching(/^skill_version_/), skill_id: created.id, name: "demo-skill", description: "first", directory: "demo-skill", type: "skill_version" });
    const versionRes = await app.request(`/v1/skills/${created.id}/versions`, { method: "POST", body: skillForm("demo-skill", "second") });
    expect(versionRes.status).toBe(200);
    const secondVersion = await versionRes.json() as { version: string };
    expect(secondVersion.version).not.toBe(firstVersion.version);
    expect((await json(app.request(`/v1/skills/${created.id}`))).latest_version).toBe(secondVersion.version);
    expect(await json(app.request("/v1/skills"))).toMatchObject({ data: [{ id: created.id }], has_more: false, next_page: null });
    expect(await json(app.request(`/v1/skills/${created.id}/versions`))).toMatchObject({ data: [{}, {}], has_more: false, next_page: null });
    expect((await app.request(`/v1/skills/${created.id}`, { method: "DELETE" })).status).toBe(400);
    for (const version of [firstVersion.version, secondVersion.version]) expect((await app.request(`/v1/skills/${created.id}/versions/${version}`, { method: "DELETE" })).status).toBe(200);
    expect(await json(app.request(`/v1/skills/${created.id}`))).toMatchObject({
      id: created.id,
      latest_version: null,
    });
    expect((await app.request(`/v1/skills/${created.id}/versions/latest`)).status).toBe(404);
    expect((await app.request(`/v1/skills/${created.id}`, { method: "DELETE" })).status).toBe(200);
    expect((await app.request(`/v1/skills/${created.id}`)).status).toBe(404);
  });

  it("deletes the current version through the latest alias", async () => {
    const app = createInMemoryControlPlaneApp();
    const created = await createSkill(app, "latest-delete", "one");
    expect((await app.request(`/v1/skills/${created.id}/versions/latest`, { method: "DELETE" })).status).toBe(200);
    expect(await json(app.request(`/v1/skills/${created.id}`))).toMatchObject({ latest_version: null });
    expect((await app.request(`/v1/skills/${created.id}/versions/latest`)).status).toBe(404);
  });

  it("derives display_title and rejects duplicate names and titles", async () => {
    const app = createInMemoryControlPlaneApp();
    await createSkill(app, "unique-skill", "one");
    expect((await app.request("/v1/skills", { method: "POST", body: skillForm("unique-skill", "two") })).status).toBe(400);
    const form = skillForm("other-skill", "other"); form.set("display_title", "unique-skill");
    const duplicateTitle = await app.request("/v1/skills", { method: "POST", body: form });
    expect(duplicateTitle.status).toBe(400); expect(await duplicateTitle.text()).toContain("display_title");
  });

  it("rejects root-level and mismatched layouts", async () => {
    const app = createInMemoryControlPlaneApp();
    const root = new FormData(); root.append("files[]", new File([skillMd("root-skill", "root")], "SKILL.md", { type: "text/markdown" }));
    const rootResponse = await app.request("/v1/skills", { method: "POST", body: root });
    expect(rootResponse.status).toBe(400);
    expect(await rootResponse.text()).toContain("Zip must contain a top-level folder");
    const mismatch = new FormData(); mismatch.append("files[]", new File([skillMd("name-a", "mismatch")], "folder-b/SKILL.md", { type: "text/markdown" }));
    const response = await app.request("/v1/skills", { method: "POST", body: mismatch });
    expect(response.status).toBe(400); expect(await response.text()).toContain("must match the skill name");
  });

  it("rejects file/directory conflicts and Unicode-equivalent duplicate paths", async () => {
    const app = createInMemoryControlPlaneApp();
    const conflict = skillForm("tree-skill", "tree");
    conflict.append("files[]", new File(["file"], "tree-skill/a"));
    conflict.append("files[]", new File(["child"], "tree-skill/a/b"));
    const conflictResponse = await app.request("/v1/skills", { method: "POST", body: conflict });
    expect(conflictResponse.status).toBe(400);
    expect(await conflictResponse.text()).toContain("file/directory path conflict");

    const unicode = skillForm("unicode-skill", "unicode");
    unicode.append("files[]", new File(["one"], "unicode-skill/caf\u00e9.txt"));
    unicode.append("files[]", new File(["two"], "unicode-skill/cafe\u0301.txt"));
    const unicodeResponse = await app.request("/v1/skills", { method: "POST", body: unicode });
    expect(unicodeResponse.status).toBe(400);
    expect(await unicodeResponse.text()).toContain("duplicate paths");
  });

  it("rejects hostile paths and too many files", async () => {
    const app = createInMemoryControlPlaneApp();
    for (const path of ["../escape", "/absolute", "hostile\\backslash", "hostile/evil\0name"]) {
      const form = skillForm("hostile", "paths");
      form.append("files[]", new File(["bad"], path));
      const response = await app.request("/v1/skills", { method: "POST", body: form });
      expect(response.status, path).toBe(400);
    }

    const crowded = skillForm("crowded", "files");
    for (let index = 0; index < MAX_SKILL_FILES; index += 1) {
      crowded.append("files[]", new File([""], `crowded/files/${index}.txt`));
    }
    const response = await app.request("/v1/skills", { method: "POST", body: crowded });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("between 1 and 500 files");
  });

  it("accepts a validated zip bundle", async () => {
    const app = createInMemoryControlPlaneApp();
    const form = new FormData();
    form.append("files[]", new File([Buffer.from(ZIP_SKILL, "base64")], "skill.zip", { type: "application/zip" }));
    const response = await app.request("/v1/skills", { method: "POST", body: form });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ display_title: "zip-skill", type: "skill" });
  });

  it("returns the hosted 413 shape above the skills request cap", async () => {
    const app = createInMemoryControlPlaneApp();
    const response = await app.request("/v1/skills", {
      method: "POST",
      headers: { "content-length": String(MAX_SKILLS_UPLOAD_REQUEST_BYTES + 1) },
      body: new FormData(),
    });
    expect(response.status).toBe(413);
    expect(await response.json()).toMatchObject({
      error: {
        type: "request_too_large",
        message: "Request exceeds the maximum size. The Skills API accepts requests up to 30MBs.",
      },
    });
  });

  it("maps malformed zip input to invalid_request_error", async () => {
    const app = createInMemoryControlPlaneApp();
    const form = new FormData();
    form.append("files[]", new File(["not a zip"], "broken.zip", { type: "application/zip" }));
    const response = await app.request("/v1/skills", { method: "POST", body: form });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("valid zip");
  });
});

const ZIP_SKILL = "UEsDBAoAAAAAAFoD61wAAAAAAAAAAAAAAAAKABwAemlwLXNraWxsL1VUCQADu39Rart/UWp1eAsAAQT1AQAABBQAAABQSwMECgAAAAAAWgPrXAAAAAAAAAAAAAAAABIAHAB6aXAtc2tpbGwvc2NyaXB0cy9VVAkAA7t/UWq7f1FqdXgLAAEE9QEAAAQUAAAAUEsDBAoAAAAAAFoD61w0Mtc9CAAAAAgAAAAYABwAemlwLXNraWxsL3NjcmlwdHMvcnVuLnNoVVQJAAO7f1Fqu39RanV4CwABBPUBAAAEFAAAAGVjaG8gb2sKUEsDBBQAAAAIAFoD61wxje8kLAAAAC4AAAASABwAemlwLXNraWxsL1NLSUxMLm1kVVQJAAO7f1Fqu39RanV4CwABBPUBAAAEFAAAANPV1eXKS8xNtVKoyizQLc7OzMnhSkktTi7KLCjJzM8DCysUJJZkcOkCVQIAUEsBAh4DCgAAAAAAWgPrXAAAAAAAAAAAAAAAAAoAGAAAAAAAAAAQAO1BAAAAAHppcC1za2lsbC9VVAUAA7t/UWp1eAsAAQT1AQAABBQAAABQSwECHgMKAAAAAABaA+tcAAAAAAAAAAAAAAAAEgAYAAAAAAAAABAA7UFEAAAAemlwLXNraWxsL3NjcmlwdHMvVVQFAAO7f1FqdXgLAAEE9QEAAAQUAAAAUEsBAh4DCgAAAAAAWgPrXDQy1z0IAAAACAAAABgAGAAAAAAAAQAAAKSBkAAAAHppcC1za2lsbC9zY3JpcHRzL3J1bi5zaFVUBQADu39RanV4CwABBPUBAAAEFAAAAFBLAQIeAxQAAAAIAFoD61wxje8kLAAAAC4AAAASABgAAAAAAAEAAACkgeoAAAB6aXAtc2tpbGwvU0tJTEwubWRVVAUAA7t/UWp1eAsAAQT1AQAABBQAAABQSwUGAAAAAAQABABeAQAAYgEAAAAA";

async function createSkill(app: ReturnType<typeof createInMemoryControlPlaneApp>, name: string, description: string) { const response=await app.request("/v1/skills",{method:"POST",body:skillForm(name,description)}); expect(response.status).toBe(200); return response.json() as Promise<any>; }
function skillForm(name:string,description:string):FormData{const form=new FormData();form.append("files[]",new File([skillMd(name,description)],`${name}/SKILL.md`,{type:"text/markdown"}));form.append("files[]",new File(["echo ok\n"],`${name}/scripts/run.sh`,{type:"text/plain"}));return form;}
function skillMd(name:string,description:string):string{return `---\nname: ${name}\ndescription: ${description}\n---\nUse this skill.\n`;}
async function json(value:Response|Promise<Response>):Promise<any>{const response=await value;expect(response.status).toBe(200);return response.json();}
