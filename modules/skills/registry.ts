import { dirname } from "node:path";

export interface SkillRecord {
  readonly name: string;
  readonly description: string;
  readonly filePath: string;
  readonly baseDir: string;
  readonly disableModelInvocation: boolean;
}

export interface SkillRegistry {
  readonly skills: readonly SkillRecord[];
}

const MAX_LISTED_NAMES = 40;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

export function registryFromEvent(event: unknown): SkillRegistry | undefined {
  if (!isRecord(event)) return undefined;

  const options = isRecord(event.systemPromptOptions) ? event.systemPromptOptions : undefined;
  if (options && Array.isArray(options.skills)) {
    return { skills: normalizeSkills(options.skills) };
  }

  const prompt = typeof event.systemPrompt === "string" ? event.systemPrompt : undefined;
  if (prompt === undefined) return undefined;
  const skills = parseAvailableSkills(prompt);
  return skills === undefined ? undefined : { skills };
}

export function normalizeSkills(rawSkills: readonly unknown[]): SkillRecord[] {
  const skills: SkillRecord[] = [];
  const seenFiles = new Set<string>();

  for (const raw of rawSkills) {
    if (!isRecord(raw)) continue;
    const name = asString(raw.name);
    const filePath = asString(raw.filePath);
    if (!name || !filePath) continue;

    const baseDir = asString(raw.baseDir) ?? dirname(filePath);
    const fileKey = `${name.toLowerCase()}\u0000${filePath}`;
    if (seenFiles.has(fileKey)) continue;
    seenFiles.add(fileKey);

    skills.push({
      name,
      description: typeof raw.description === "string" ? raw.description : "",
      filePath,
      baseDir,
      disableModelInvocation: raw.disableModelInvocation === true,
    });
  }

  return skills;
}

export function parseAvailableSkills(systemPrompt: string): SkillRecord[] | undefined {
  const start = systemPrompt.indexOf("<available_skills>");
  if (start === -1) return undefined;
  const end = systemPrompt.indexOf("</available_skills>", start);
  if (end === -1) return undefined;

  const section = systemPrompt.slice(start, end);
  const rawSkills: unknown[] = [];
  const blockPattern = /<skill>([\s\S]*?)<\/skill>/g;
  for (const block of section.matchAll(blockPattern)) {
    const body = block[1] ?? "";
    rawSkills.push({
      name: readTag(body, "name"),
      description: readTag(body, "description") ?? "",
      filePath: readTag(body, "location"),
      disableModelInvocation: false,
    });
  }
  return normalizeSkills(rawSkills);
}

function readTag(block: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(block);
  if (!match) return undefined;
  const value = unescapeXml(match[1] ?? "").trim();
  return value === "" ? undefined : value;
}

const XML_UNESCAPES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'",
};

export function unescapeXml(value: string): string {
  return value.replace(/&(amp|lt|gt|quot|apos);/g, (match) => XML_UNESCAPES[match] ?? match);
}

export function normalizeSkillName(query: string): string {
  return query.trim().replace(/^\/?skill:/i, "").trim().toLowerCase();
}

export type SkillLookup =
  | { readonly kind: "found"; readonly skill: SkillRecord }
  | { readonly kind: "ambiguous"; readonly skills: readonly SkillRecord[] }
  | { readonly kind: "missing" };

export function findSkill(skills: readonly SkillRecord[], query: string): SkillLookup {
  const normalized = normalizeSkillName(query);
  if (!normalized) return { kind: "missing" };

  const matches = skills.filter((skill) => skill.name.toLowerCase() === normalized);
  if (matches.length === 0) return { kind: "missing" };
  if (matches.length > 1) return { kind: "ambiguous", skills: matches };
  return { kind: "found", skill: matches[0] };
}

export function unknownSkillError(registry: SkillRegistry, query: string): Error {
  const requested = query.trim();
  const label = requested === "" ? "(empty)" : requested;
  const names = [...new Set(registry.skills.map((skill) => skill.name))].slice(0, MAX_LISTED_NAMES);
  const listed = names.length > 0 ? names.join(", ") : "(none)";
  const more = registry.skills.length > MAX_LISTED_NAMES ? ", …" : "";
  const suggestion = suggestSkillName(registry.skills, query);
  const hint = suggestion ? ` Did you mean "${suggestion}"?` : "";

  return new Error(
    `Unknown skill "${label}". Available skills: ${listed}${more} (${registry.skills.length} total).${hint}`,
  );
}

export function ambiguousSkillError(skills: readonly SkillRecord[], query: string): Error {
  const candidates = skills.map((skill) => `${skill.name} at ${skill.filePath}`).join("; ");
  return new Error(`Skill "${query.trim()}" is ambiguous; multiple paths match: ${candidates}`);
}

export function noSkillsError(): Error {
  return new Error("No skills are available in this session.");
}

export function notIndexedError(): Error {
  return new Error("Skills are not indexed yet; retry the skill tool on the next turn.");
}

export function suggestSkillName(skills: readonly SkillRecord[], query: string): string | undefined {
  const normalized = normalizeSkillName(query);
  if (!normalized) return undefined;

  let best: { readonly name: string; readonly distance: number } | undefined;
  for (const skill of skills) {
    const distance = editDistance(normalized, skill.name.toLowerCase());
    if (best === undefined || distance < best.distance) {
      best = { name: skill.name, distance };
    }
  }

  const threshold = Math.max(2, Math.floor(normalized.length / 3));
  if (!best || best.distance === 0 || best.distance > threshold) return undefined;
  return best.name;
}

function editDistance(a: string, b: string): number {
  const previous: number[] = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current: number[] = new Array<number>(b.length + 1).fill(0);

  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const insertion = (current[j - 1] ?? 0) + 1;
      const deletion = (previous[j] ?? 0) + 1;
      current[j] = Math.min(substitution, insertion, deletion);
    }
    for (let j = 0; j <= b.length; j += 1) {
      previous[j] = current[j] ?? 0;
    }
  }

  return previous[b.length] ?? 0;
}
