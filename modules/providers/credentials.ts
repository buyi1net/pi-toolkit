import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { PiProviderAccessConfig } from "./api.ts";
import {
	parseProviderCredentials,
	parseProviderQueries,
	ProviderConfigValidationError,
} from "./kernel/usage-core.ts";

export const PI_TUI_CONFIG_FILENAME = "pi-tui.json";

export function piTuiConfigPath(agentDir: string): string {
	return join(agentDir, PI_TUI_CONFIG_FILENAME);
}

export type ProviderWarningKind =
	| "readFailed"
	| "parseFailed"
	| "notObject"
	| "badGithubDomain"
	| "invalid";

export interface ProviderWarning {
	readonly kind: ProviderWarningKind;
}

export interface LoadedProviderAccess {

	readonly exists: boolean;

	readonly access?: PiProviderAccessConfig;
	readonly warnings: readonly ProviderWarning[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readGithubDomain(value: unknown, warnings: ProviderWarning[]): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		warnings.push({ kind: "badGithubDomain" });
		return undefined;
	}
	const domain = value.trim().toLowerCase();
	try {
		const url = new URL(`https://${domain}`);
		if (url.hostname !== domain || url.port || url.pathname !== "/" || url.username || url.password) {
			throw new Error();
		}
		return domain;
	} catch {
		warnings.push({ kind: "badGithubDomain" });
		return undefined;
	}
}

function readProviderAccess(value: unknown, warnings: ProviderWarning[]): PiProviderAccessConfig | undefined {
	if (!isRecord(value)) {
		warnings.push({ kind: "invalid" });
		return undefined;
	}
	try {
		const queries = parseProviderQueries(value.queries, "data.providerAccess.queries");
		const githubDomain = readGithubDomain(value.githubDomain, warnings);
		const credentials = parseProviderCredentials(value.credentials, "data.providerAccess.credentials");
		return {
			...(queries ? { queries } : {}),
			...(Object.keys(credentials).length > 0 ? { credentials } : {}),
			...(githubDomain ? { githubDomain } : {}),
		};
	} catch (error) {
		if (!(error instanceof ProviderConfigValidationError)) throw error;
		warnings.push({ kind: "invalid" });
		return undefined;
	}
}

export function loadProviderAccessFile(agentDir: string): LoadedProviderAccess {
	const path = piTuiConfigPath(agentDir);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return { exists: false, warnings: [] };
		}
		return { exists: false, warnings: [{ kind: "readFailed" }] };
	}

	const warnings: ProviderWarning[] = [];
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch {
		warnings.push({ kind: "parseFailed" });
		return { exists: true, warnings };
	}
	if (!isRecord(root)) {
		warnings.push({ kind: "notObject" });
		return { exists: true, warnings };
	}
	const data = root.data;
	if (!isRecord(data) || data.providerAccess === undefined) {
		return { exists: true, warnings };
	}
	return { exists: true, access: readProviderAccess(data.providerAccess, warnings), warnings };
}

export function providerAccessConfigured(agentDir: string): boolean {
	return loadProviderAccessFile(agentDir).exists;
}
