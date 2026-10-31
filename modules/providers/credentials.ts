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

export interface LoadedProviderAccess {

	readonly exists: boolean;

	readonly access?: PiProviderAccessConfig;
	readonly warnings: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function readGithubDomain(value: unknown, warnings: string[]): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !value.trim()) {
		warnings.push("data.providerAccess.githubDomain 必须是非空字符串，已忽略");
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
		warnings.push("data.providerAccess.githubDomain 必须是主机名，已忽略");
		return undefined;
	}
}

const VALIDATION_RULES = {
	object: "必须是对象",
	array: "必须是数组",
	nonEmptyArray: "必须是非空数组",
	nonEmptyString: "必须是非空字符串",
	choice: "的值无效",
} as const;

function readProviderAccess(value: unknown, warnings: string[]): PiProviderAccessConfig | undefined {
	if (!isRecord(value)) {
		warnings.push("data.providerAccess 必须是对象，已忽略");
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
		warnings.push(`${error.field} ${VALIDATION_RULES[error.rule]}，已忽略`);
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
		return { exists: false, warnings: [`${path}: 读取失败（${(error as Error).message}），供应商查询按未配置处理`] };
	}

	const warnings: string[] = [];
	let root: unknown;
	try {
		root = JSON.parse(text);
	} catch (error) {
		warnings.push(`${path}: 解析失败（${(error as Error).message}），供应商查询按未配置处理`);
		return { exists: true, warnings };
	}
	if (!isRecord(root)) {
		warnings.push(`${path}: 顶层不是对象，供应商查询按未配置处理`);
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
