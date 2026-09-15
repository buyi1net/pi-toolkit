// i18n 引擎：语言设置解析、译者工厂、占位符替换与键表登记。
// 框架级键表在 ./messages.ts（整表由本文件持有）；模块自带的键表由 modules/index.ts 聚合登记。
//
// 键从"全表 keyof"改为"模块命名空间"（工单 09 定案）：Translator 收 string，
// 模块内的局部 keyof 校验由各模块 messages/ 导出的键类型承担，
// 跨模块 / 契约字段（labelKey 等）的键存在性落到运行时 hasMessage 与三语完整性测试。

import { execFileSync } from "node:child_process";

import {
	FRAMEWORK_MESSAGES,
	type FrameworkMessageKey,
	type MessageTable,
	type MessageTables,
	type MessageVars,
} from "./messages.ts";

/** 实际生效的语言：三语键表各一份 */
export type ResolvedLanguage = "en" | "zh-CN" | "zh-TW";

/** 全部生效语言：登记与完整性校验按它枚举 */
export const RESOLVED_LANGUAGES: readonly ResolvedLanguage[] = ["en", "zh-CN", "zh-TW"];

/** 配置里保存的语言设置：auto 跟随系统语言 */
export type LanguageSetting = "auto" | ResolvedLanguage;

export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ["auto", "en", "zh-CN", "zh-TW"];

/**
 * 取当前语言文案；{name} 占位符由 vars 替换。
 * 键是运行时字符串：模块自己的键类型在模块内使用，框架键类型用 FrameworkMessageKey。
 */
export type Translator = (key: string, vars?: MessageVars) => string;

/**
 * 运行时可查的全部键 = 框架表 + 已登记模块表（同一语言的键合并到一张表）。
 * 模块表在模块装载时登记，查询发生在调用时，因此登记顺序不影响结果。
 */
const TABLES: Record<ResolvedLanguage, MessageTable> = {
	en: { ...FRAMEWORK_MESSAGES.en },
	"zh-CN": { ...FRAMEWORK_MESSAGES["zh-CN"] },
	"zh-TW": { ...FRAMEWORK_MESSAGES["zh-TW"] },
};

/**
 * 登记一份三语键表。模块自己的 messages/ 由 modules/index.ts 统一登记（单一聚合点），
 * 登记后该模块的键对全进程的 Translator / hasMessage 可见；重复登记以后来的为准。
 */
export function registerMessages(tables: MessageTables): void {
	for (const language of RESOLVED_LANGUAGES) {
		Object.assign(TABLES[language], tables[language]);
	}
}

function format(template: string | undefined, key: string, vars?: MessageVars): string {
	// 未登记的键：回显键名而不是抛错或渲染 undefined（键存在性由 hasMessage 与完整性测试兜底）
	if (template === undefined) return key;
	if (!vars) return template;
	return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
		Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : whole,
	);
}

/**
 * auto 解析：从系统语言候选里取第一个中文（非中文则 en）；纯函数，候选须已按权威度排好。
 * 规则：zh 且含 hant/tw/hk/mo → zh-TW；其余 zh → zh-CN；无中文候选 → en。
 */
export function resolveSystemLanguage(candidates: readonly string[]): ResolvedLanguage {
	for (const candidate of candidates) {
		const locale = candidate.toLowerCase().replace(/_/g, "-");
		if (!locale.startsWith("zh")) continue;
		return /(hant|tw|hk|mo)/.test(locale) ? "zh-TW" : "zh-CN";
	}
	return "en";
}

/**
 * macOS 的「语言与地区」偏好（如 zh_CN）：终端环境变量（LANG）常是 en_US.UTF-8，
 * 会让 Intl 误报 en，所以系统偏好优先于 Intl。读不到（非 mac / 命令失败）返回 undefined。
 */
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

/** 系统语言候选（按权威度）：平台系统偏好 → Intl（跟随系统 / LANG） */
function systemLocaleCandidates(): string[] {
	const candidates: string[] = [];
	const apple = macOsSystemLocale();
	if (apple !== undefined) candidates.push(apple);
	try {
		candidates.push(Intl.DateTimeFormat().resolvedOptions().locale);
	} catch {
		// Intl 异常（理论外）：跳过该候选
	}
	return candidates;
}

/** auto 检测结果缓存：检测含子进程调用，不能随每次翻译重跑（进程内一次） */
let resolvedAutoLanguage: ResolvedLanguage | undefined;

/** auto 解析规则：非中文 → en；繁体地区 → zh-TW；其余中文 → zh-CN */
export function resolveLanguage(setting: LanguageSetting): ResolvedLanguage {
	if (setting !== "auto") return setting;
	resolvedAutoLanguage ??= resolveSystemLanguage(systemLocaleCandidates());
	return resolvedAutoLanguage;
}

/** 仅测试用：重置 auto 检测缓存；暴露系统候选构造，供 auto 结果一致性断言 */
export const __test__ = {
	resetAutoLanguageCache: (): void => {
		resolvedAutoLanguage = undefined;
	},
	systemLocaleCandidates,
};

export function isLanguageSetting(value: unknown): value is LanguageSetting {
	return typeof value === "string" && (LANGUAGE_SETTINGS as readonly string[]).includes(value);
}

/**
 * 键表里是否存在该键（框架表 + 已登记模块表的并集）；
 * 枚举值的显示文案 `<labelKey>.<value>` 靠它做可选解析，契约字段（labelKey 等）的键校验也靠它。
 */
export function hasMessage(key: string): boolean {
	return Object.prototype.hasOwnProperty.call(TABLES.en, key);
}

/**
 * 按占位符规则格式化一条模板（未登记键回显键名）。
 * 供没有宿主装配、全局键表未登记的场合（如独立 `-e` 装载的 subagents 模块）
 * 用自己的模块键表自制兜底译者，与引擎译者共用同一套替换语义。
 */
export function formatMessage(template: string | undefined, key: string, vars?: MessageVars): string {
	return format(template, key, vars);
}

/** 语言设置对应的显示名键，用于语言选择项（框架表键） */
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

/**
 * 造一个始终读当前语言的译者；语言切换后无需更换实例，菜单重建即可刷新文案。
 */
export function createTranslator(getLanguage: () => ResolvedLanguage): Translator {
	return (key, vars) => format(TABLES[getLanguage()][key], key, vars);
}
