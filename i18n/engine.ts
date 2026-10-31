import { execFileSync } from "node:child_process";

import {
	FRAMEWORK_MESSAGES,
	type FrameworkMessageKey,
	type MessageTable,
	type MessageTables,
	type MessageVars,
} from "./messages.ts";

export type ResolvedLanguage = "en" | "zh-CN" | "zh-TW";

export const RESOLVED_LANGUAGES: readonly ResolvedLanguage[] = ["en", "zh-CN", "zh-TW"];

export type LanguageSetting = "auto" | ResolvedLanguage;

export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ["auto", "en", "zh-CN", "zh-TW"];

export type Translator = (key: string, vars?: MessageVars) => string;

const TABLES: Record<ResolvedLanguage, MessageTable> = {
	en: { ...FRAMEWORK_MESSAGES.en },
	"zh-CN": { ...FRAMEWORK_MESSAGES["zh-CN"] },
	"zh-TW": { ...FRAMEWORK_MESSAGES["zh-TW"] },
};

export function registerMessages(tables: MessageTables): void {
	for (const language of RESOLVED_LANGUAGES) {
		Object.assign(TABLES[language], tables[language]);
	}
}

function format(template: string | undefined, key: string, vars?: MessageVars): string {

	if (template === undefined) return key;
	if (!vars) return template;
	return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
		Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
	);
}

export function resolveSystemLanguage(candidates: readonly string[]): ResolvedLanguage {
	for (const candidate of candidates) {
		const locale = candidate.toLowerCase().replace(/_/g, "-");
		if (!locale.startsWith("zh")) continue;
		return /(hant|tw|hk|mo)/.test(locale) ? "zh-TW" : "zh-CN";
	}
	return "en";
}

function macOsSystemLocale(): string | undefined {
	if (process.platform !== "darwin") return undefined;
	try {
		const output = execFileSync("defaults", ["read", "-g", "AppleLocale"], {
			encoding: "utf8",
			timeout: 2000,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const locale = output.trim();
		return locale === "" ? undefined : locale;
	} catch {
		return undefined;
	}
}

function systemLocaleCandidates(): string[] {
	const candidates: string[] = [];
	const apple = macOsSystemLocale();
	if (apple !== undefined) candidates.push(apple);
	try {
		candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
	} catch {

	}
	return candidates;
}

let resolvedAutoLanguage: ResolvedLanguage | undefined;

export function resolveLanguage(setting: LanguageSetting): ResolvedLanguage {
	if (setting !== "auto") return setting;
	resolvedAutoLanguage ??= resolveSystemLanguage(systemLocaleCandidates());
	return resolvedAutoLanguage;
}

export const __test__ = {
	resetAutoLanguageCache: (): void => {
		resolvedAutoLanguage = undefined;
	},
	systemLocaleCandidates,
};

export function isLanguageSetting(value: unknown): value is LanguageSetting {
	return typeof value === "string" && (LANGUAGE_SETTINGS as readonly string[]).includes(value);
}

export function hasMessage(key: string): boolean {
	return Object.prototype.hasOwnProperty.call(TABLES.en, key);
}

export function formatMessage(template: string | undefined, key: string, vars?: MessageVars): string {
	return format(template, key, vars);
}

export function languageLabelKey(setting: LanguageSetting): FrameworkMessageKey {
	switch (setting) {
		case "auto":
			return "language.auto";
		case "en":
			return "language.en";
		case "zh-CN":
			return "language.zhCN";
		case "zh-TW":
			return "language.zhTW";
	}
}

export function createTranslator(getLanguage: () => ResolvedLanguage): Translator {
	return (key, vars) => format(TABLES[getLanguage()][key], key, vars);
}
