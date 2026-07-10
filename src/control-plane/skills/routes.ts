import { File as NodeFile } from "node:buffer";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AdmissionLimits } from "../admission.ts";
import { invalidRequest, requestTooLarge, toApiErrorBody } from "../errors.ts";
import { parseLimit } from "../http.ts";
import { workspaceIdFrom, type ControlPlaneRouteEnv } from "../workspace.ts";
import type { SkillsService } from "./types.ts";

export const MAX_SKILLS_UPLOAD_REQUEST_BYTES = 30 * 1024 * 1024;

export function skillsRoutes(service: SkillsService, admission?: AdmissionLimits): Hono<ControlPlaneRouteEnv> {
  const app = new Hono<ControlPlaneRouteEnv>();
  app.use("*", async (c,next) => { if(c.req.method!=="POST" || admission===undefined) return next(); const release=admission.uploads.acquire(workspaceIdFrom(c)); try { await next(); } finally { release(); } });
  app.use("*", bodyLimit({ maxSize: MAX_SKILLS_UPLOAD_REQUEST_BYTES, onError: (c) => { const error=requestTooLarge("Request exceeds the maximum size. The Skills API accepts requests up to 30MBs."); return c.json(toApiErrorBody(error,c.get("requestId")),413); } }));
  app.post("/", async (c) => { const body=await multipart(c.req); return c.json(await service.create(workspaceIdFrom(c), stringField(body.display_title), await files(body["files[]"])),200); });
  app.get("/", (c) => c.json(service.list(workspaceIdFrom(c), parseLimit(c.req.query("limit")) ?? 20, c.req.query("page") || undefined),200));
  app.get("/:id", (c) => c.json(service.get(workspaceIdFrom(c),c.req.param("id")),200));
  app.delete("/:id", (c) => c.json(service.delete(workspaceIdFrom(c),c.req.param("id")),200));
  app.post("/:id/versions", async (c) => { const body=await multipart(c.req); return c.json(await service.createVersion(workspaceIdFrom(c),c.req.param("id"),await files(body["files[]"])),200); });
  app.get("/:id/versions", (c) => c.json(service.listVersions(workspaceIdFrom(c),c.req.param("id"),parseLimit(c.req.query("limit")) ?? 20,c.req.query("page")||undefined),200));
  app.get("/:id/versions/:version", (c) => c.json(service.getVersion(workspaceIdFrom(c),c.req.param("id"),c.req.param("version")),200));
  app.delete("/:id/versions/:version", (c) => c.json(service.deleteVersion(workspaceIdFrom(c),c.req.param("id"),c.req.param("version")),200));
  return app;
}

async function multipart(req: { parseBody(opts:{all:true}):Promise<Record<string,unknown>> }): Promise<Record<string,unknown>> { try{return await req.parseBody({all:true});}catch(error){throw invalidRequest("Request body must be valid multipart/form-data",String(error));} }
function isFile(value: unknown): value is File { return value instanceof NodeFile || (!!value && typeof value==="object" && "arrayBuffer" in value && "name" in value); }
async function files(value: unknown): Promise<Array<{name:string;bytes:Uint8Array}>> { const values=Array.isArray(value)?value:value===undefined?[]:[value]; const out=[]; for(const value of values){ if(!isFile(value)) throw invalidRequest("`files[]` is required"); out.push({name:value.name,bytes:new Uint8Array(await value.arrayBuffer())}); } if(out.length===0) throw invalidRequest("`files[]` is required"); return out; }
function stringField(value: unknown): string | undefined { return typeof value==="string"?value:undefined; }
