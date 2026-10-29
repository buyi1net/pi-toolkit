import { parseFrontmatter } from "@earendil-works/pi-coding-agent";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import { normalizeSkillName, type SkillRecord } from "./registry.ts";

export const MAX_BODY_CHARS = 256 * 1024;
export const MAX_BUNDLED_FILES = 60;
export const MAX_LISTING_DEPTH = 2;

const MAX_SCANNED_FILES = 1000;
const IGNORED_DIRECTORIES = new Set(["node_modules", ".git"]);

export interface SkillFileContent {
  readonly body: string;
  readonly truncated: boolean;
}

export interface BundledFileListing {
  readonly files: readonly string[];
  readonly more: number;
}

export async function readSkillFile(skill: SkillRecord): Promise<SkillFileContent> {
  const baseDir = await resolveRealPath(skill.baseDir, "skill directory");
  const filePath = await resolveRealPath(skill.filePath, `skill "${skill.name}"`);
  if (!isWithinPath(filePath, baseDir)) {
    throw new Error(`Skill "${skill.name}" file escapes its skill directory: ${skill.filePath}`);
  }

  const fileStats = await stat(filePath);
  if (!fileStats.isFile()) {
    throw new Error(`Skill "${skill.name}" path is not a file: ${skill.filePath}`);
  }

  const raw = await readFile(filePath, "utf8");
  let parsed: { readonly frontmatter: Record<string, unknown>; readonly body: string };
  try {
    parsed = parseFrontmatter(raw) as { frontmatter: Record<string, unknown>; body: string };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse skill "${skill.name}" at ${skill.filePath}: ${reason}`);
  }

  const declaredName = parsed.frontmatter.name;
  if (typeof declaredName === "string" && normalizeSkillName(declaredName) !== normalizeSkillName(skill.name)) {
    throw new Error(
      `Skill "${skill.name}" frontmatter name changed to "${declaredName}" at ${skill.filePath}`,
    );
  }

  let body = parsed.body.trim();
  let truncated = false;
  if (body.length > MAX_BODY_CHARS) {
    body = body.slice(0, MAX_BODY_CHARS);
    truncated = true;
  }
  return { body, truncated };
}

export async function listBundledFiles(baseDir: string): Promise<BundledFileListing> {
  let resolvedBaseDir: string;
  try {
    resolvedBaseDir = await realpath(baseDir);
  } catch {
    return { files: [], more: 0 };
  }

  const state = { files: [] as string[], count: 0 };
  await collectFiles(resolvedBaseDir, resolvedBaseDir, 0, state);
  return {
    files: state.files,
    more: Math.max(0, state.count - state.files.length),
  };
}

async function collectFiles(
  dir: string,
  baseDir: string,
  depth: number,
  state: { files: string[]; count: number },
): Promise<void> {
  if (state.count >= MAX_SCANNED_FILES) return;

  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));

  for (const entry of entries) {
    if (state.count >= MAX_SCANNED_FILES) return;
    if (entry.name.startsWith(".") || IGNORED_DIRECTORIES.has(entry.name)) continue;
    if (entry.isSymbolicLink()) continue;

    const fullPath = join(dir, entry.name);
    const relativePath = toPosixPath(relative(baseDir, fullPath));
    if (relativePath === "SKILL.md") continue;

    if (entry.isDirectory()) {
      if (depth < MAX_LISTING_DEPTH) {
        await collectFiles(fullPath, baseDir, depth + 1, state);
      }
      continue;
    }

    state.count += 1;
    if (state.files.length < MAX_BUNDLED_FILES) {
      state.files.push(relativePath);
    }
  }
}

export interface FormatSkillResultInput {
  readonly skill: SkillRecord;
  readonly body: string;
  readonly args?: string;
  readonly bundledFiles?: BundledFileListing;
  readonly truncated?: boolean;
}

export function formatSkillResult(input: FormatSkillResultInput): string {
  const { skill, body, args, bundledFiles, truncated } = input;
  const parts: string[] = [
    `<skill name="${escapeXmlAttribute(skill.name)}" location="${escapeXmlAttribute(skill.filePath)}">`,
    `References are relative to ${skill.baseDir}.`,
    "",
    body,
    "</skill>",
  ];

  const trimmedArgs = args?.trim();
  if (trimmedArgs) parts.push("", trimmedArgs);

  if (truncated) {
    parts.push(
      "",
      `Note: this skill file exceeds ${MAX_BODY_CHARS} characters; the instructions above are truncated. Read the remainder at ${skill.filePath}.`,
    );
  }

  if (bundledFiles && bundledFiles.files.length > 0) {
    parts.push("", `Bundled files (relative to ${skill.baseDir}):`);
    for (const file of bundledFiles.files) parts.push(`- ${file}`);
    if (bundledFiles.more > 0) parts.push(`- … (${bundledFiles.more} more)`);
  }

  return parts.join("\n");
}

export function escapeXmlAttribute(value: string): string {
  const escapes: Record<string, string> = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  };
  return value.replace(/[&<>"']/g, (character) => escapes[character] ?? character);
}

async function resolveRealPath(path: string, label: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to resolve ${label} at ${path}: ${reason}`);
  }
}

function isWithinPath(target: string, root: string): boolean {
  const normalizedTarget = resolve(target);
  const normalizedRoot = resolve(root);
  if (normalizedTarget === normalizedRoot) return true;
  const prefix = normalizedRoot.endsWith(sep) ? normalizedRoot : `${normalizedRoot}${sep}`;
  return normalizedTarget.startsWith(prefix);
}

function toPosixPath(value: string): string {
  return sep === "/" ? value : value.split(sep).join("/");
}
