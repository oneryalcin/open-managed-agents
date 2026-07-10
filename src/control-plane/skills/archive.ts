import { createHash } from "node:crypto";
import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import yauzl, { type Entry, type ZipFile } from "yauzl";
import { invalidRequest } from "../errors.ts";
import {
  MAX_SKILL_FILE_BYTES,
  MAX_SKILL_FILES,
  MAX_SKILL_VERSION_BYTES,
  type ValidatedSkillBundle,
  type ValidatedSkillFile,
} from "./types.ts";

export async function validateSkillUpload(
  inputs: readonly { name: string; bytes: Uint8Array }[],
): Promise<ValidatedSkillBundle> {
  if (inputs.length === 0) throw invalidRequest("`files[]` is required");
  const zip = inputs.length === 1 && inputs[0]!.name.toLowerCase().endsWith(".zip");
  let raw: readonly { name: string; bytes: Uint8Array }[];
  try { raw = zip ? await unzip(inputs[0]!.bytes) : inputs; }
  catch (error) {
    if (typeof error === "object" && error !== null && "status" in error) throw error;
    throw invalidRequest("Skill archive must be a valid zip", String(error));
  }
  return validateFiles(raw);
}

async function unzip(bytes: Uint8Array): Promise<Array<{ name: string; bytes: Uint8Array }>> {
  const zip = await openZip(bytes);
  const files: Array<{ name: string; bytes: Uint8Array }> = [];
  let total = 0;
  try {
    while (true) {
      const entry = await nextEntry(zip);
      if (entry === undefined) break;
      assertEntrySafe(entry);
      if (entry.fileName.endsWith("/")) continue;
      if (entry.uncompressedSize > MAX_SKILL_FILE_BYTES) throw invalidRequest("Skill file exceeds the 20 MiB limit");
      total += entry.uncompressedSize;
      if (total > MAX_SKILL_VERSION_BYTES) throw invalidRequest("Skill content exceeds the 100 MiB limit");
      if (files.length >= MAX_SKILL_FILES) throw invalidRequest("Skill contains more than 500 files");
      files.push({ name: entry.fileName, bytes: await readEntry(zip, entry) });
    }
  } finally {
    zip.close();
  }
  return files;
}

function openZip(bytes: Uint8Array): Promise<ZipFile> {
  return new Promise((resolve, reject) => yauzl.fromBuffer(Buffer.from(bytes), {
    lazyEntries: true,
    validateEntrySizes: true,
    decodeStrings: true,
  }, (error, zip) => error || !zip ? reject(error ?? new Error("Invalid zip")) : resolve(zip)));
}

function nextEntry(zip: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => { cleanup(); resolve(entry); };
    const onEnd = () => { cleanup(); resolve(undefined); };
    const onError = (error: Error) => { cleanup(); reject(error); };
    const cleanup = () => { zip.off("entry", onEntry); zip.off("end", onEnd); zip.off("error", onError); };
    zip.once("entry", onEntry); zip.once("end", onEnd); zip.once("error", onError); zip.readEntry();
  });
}

function assertEntrySafe(entry: Entry): void {
  const name = entry.fileName;
  if ((entry.generalPurposeBitFlag & 1) !== 0) throw invalidRequest("Encrypted zip entries are not supported");
  if (name.includes("\\") || name.includes("\0") || name.startsWith("/") || name.split("/").includes("..")) {
    throw invalidRequest("Skill archive contains an unsafe path");
  }
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const kind = mode & 0xf000;
  if (kind !== 0 && kind !== 0x8000 && kind !== 0x4000) throw invalidRequest("Skill archive contains a non-regular entry");
}

function readEntry(zip: ZipFile, entry: Entry): Promise<Uint8Array> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (error, stream) => {
    if (error || !stream) { reject(error ?? new Error("Cannot read zip entry")); return; }
    const chunks: Buffer[] = []; let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_SKILL_FILE_BYTES) stream.destroy(new Error("Skill file exceeds the 20 MiB limit"));
      else chunks.push(chunk);
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
  }));
}

function validateFiles(raw: readonly { name: string; bytes: Uint8Array }[]): ValidatedSkillBundle {
  if (raw.length === 0 || raw.length > MAX_SKILL_FILES) throw invalidRequest("Skill must contain between 1 and 500 files");
  const seen = new Set<string>(); const folded = new Set<string>(); const files: ValidatedSkillFile[] = [];
  let totalBytes = 0;
  for (const item of raw) {
    const path = normalizePath(item.name);
    const lower = path.toLocaleLowerCase("en-US");
    if (seen.has(path) || folded.has(lower)) throw invalidRequest("Skill contains duplicate paths");
    seen.add(path); folded.add(lower);
    if (item.bytes.byteLength > MAX_SKILL_FILE_BYTES) throw invalidRequest("Skill file exceeds the 20 MiB limit");
    totalBytes += item.bytes.byteLength;
    if (totalBytes > MAX_SKILL_VERSION_BYTES) throw invalidRequest("Skill content exceeds the 100 MiB limit");
    files.push({ path, bytes: item.bytes, size: item.bytes.byteLength, sha256: sha256(item.bytes) });
  }
  for (const path of seen) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      const prefix = segments.slice(0, index).join("/");
      if (seen.has(prefix) || folded.has(prefix.toLocaleLowerCase("en-US"))) {
        throw invalidRequest("Skill contains a file/directory path conflict");
      }
    }
  }
  const roots = new Set(files.map((file) => file.path.split("/")[0]));
  if (roots.size !== 1 || files.some((file) => !file.path.includes("/"))) {
    throw invalidRequest("Zip must contain a top-level folder with all files inside it, including SKILL.md");
  }
  const directory = [...roots][0]!;
  const skillFiles = files.filter((file) => file.path === `${directory}/SKILL.md`);
  if (skillFiles.length !== 1) throw invalidRequest("Skill must contain exactly one top-level SKILL.md");
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(skillFiles[0]!.bytes); }
  catch { throw invalidRequest("SKILL.md must be valid UTF-8"); }
  let frontmatter: { name?: unknown; description?: unknown };
  try {
    ({ frontmatter } = parseFrontmatter<{ name?: unknown; description?: unknown }>(text));
  } catch (error) {
    throw invalidRequest("SKILL.md frontmatter must be valid YAML", String(error));
  }
  const name = typeof frontmatter.name === "string" ? frontmatter.name : "";
  const description = typeof frontmatter.description === "string" ? frontmatter.description : "";
  if (!/^(?!anthropic$|claude$)(?!-)(?!.*--)[a-z0-9-]{1,64}(?<!-)$/.test(name)) throw invalidRequest("SKILL.md has an invalid name");
  if (description.length === 0 || description.length > 1024) throw invalidRequest("SKILL.md has an invalid description");
  if (name !== directory) throw invalidRequest(`The folder name '${directory}' must match the skill name '${name}' in SKILL.md.`);
  const manifest = files.map(({ path, size, sha256 }) => ({ path, size, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  return { name, description, directory, files, totalBytes, manifestSha256: sha256(Buffer.from(JSON.stringify(manifest))) };
}

function normalizePath(value: string): string {
  if (value.includes("\\") || value.includes("\0") || value.startsWith("/") || value.endsWith("/")) throw invalidRequest("Skill contains an unsafe path");
  const parts = value.split("/").filter((part) => part.length > 0 && part !== ".").map((part) => part.normalize("NFC"));
  if (parts.length === 0 || parts.includes("..")) throw invalidRequest("Skill contains an unsafe path");
  return parts.join("/");
}

function sha256(bytes: Uint8Array): string { return createHash("sha256").update(bytes).digest("hex"); }
