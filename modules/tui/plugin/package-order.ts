// 包顺序自调：Pi 的 packages 按数组顺序串行加载，且 pi install 固定 append 到
// 末尾——本包含 TUI 外观类扩展，需要尽早加载（闸门/看门狗越早挂，宿主与其
// 它扩展的初始化输出越少暴露）。检测到不在首位时调整一次并写回 + 通知。
// 幂等且可退出：已在首位零动作；settings 里 piToolkitKeepPackageOrder=true 或
// 环境变量 PI_TOOLKIT_KEEP_PACKAGE_ORDER=1 时永不调整；写回失败静默放弃。
//
// 迁入 pi-toolkit 后按新包名适配（保留行为，只换标识）：原 pi-tui 的
// `piTuiKeepPackageOrder` / `PI_TUI_KEEP_PACKAGE_ORDER` 不再识别；识别目标
// 也从 pi-tui 包换成声明 `pi.extensions` 的本包（pi-toolkit）。

import { readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

interface GitRepositoryIdentity {
	host: string;
	path: string;
}

interface SelfPackageIdentity {
	dir: string;
	name: string;
	repository?: GitRepositoryIdentity;
}

function entrySource(entry: unknown): string | undefined {
	if (typeof entry === "string") return entry;
	if (!entry || typeof entry !== "object" || !("source" in entry)) return undefined;
	const source = (entry as { source: unknown }).source;
	return typeof source === "string" ? source : undefined;
}

function npmPackageName(source: string): string | undefined {
	if (!source.startsWith("npm:")) return undefined;
	const spec = source.slice(4).trim();
	if (!spec) return undefined;
	if (!spec.startsWith("@")) return spec.split("@", 1)[0] || undefined;
	const slash = spec.indexOf("/");
	if (slash < 0) return undefined;
	const version = spec.indexOf("@", slash);
	return version < 0 ? spec : spec.slice(0, version);
}

function gitRepositoryIdentity(source: string): GitRepositoryIdentity | undefined {
	let value = source.trim();
	const prefixed = value.startsWith("git:") && !value.startsWith("git://");
	if (prefixed) value = value.slice(4).trim();
	value = value.replace(/^git\+/, "");

	let host: string;
	let path: string;
	const scp = value.match(/^git@([^:]+):(.+)$/);
	if (scp) {
		if (!prefixed) return undefined;
		host = scp[1]!;
		path = scp[2]!;
	} else if (/^(?:https?|ssh|git):\/\//i.test(value)) {
		try {
			const parsed = new URL(value);
			host = parsed.hostname;
			path = parsed.pathname.replace(/^\/+/, "");
		} catch {
			return undefined;
		}
	} else if (prefixed) {
		const slash = value.indexOf("/");
		if (slash < 0) return undefined;
		host = value.slice(0, slash);
		path = value.slice(slash + 1);
	} else {
		return undefined;
	}

	path = path.split(/[?#]/, 1)[0]!.split("@", 1)[0]!.replace(/\/+$/, "").replace(/\.git$/i, "");
	if (!host || !path || !path.includes("/")) return undefined;
	return { host: host.toLowerCase(), path };
}

/** 判断 packages 项是否指向本插件（本地路径、npm 名称或 Git 仓库）。 */
function isSelfEntry(entry: unknown, self: SelfPackageIdentity, baseDir: string): boolean {
	const source = entrySource(entry);
	if (!source) return false;

	const npmName = npmPackageName(source);
	if (npmName) return npmName === self.name;

	const repository = gitRepositoryIdentity(source);
	if (repository) {
		return repository.host === self.repository?.host && repository.path === self.repository.path;
	}
	if (/^(?:git:|https?:|ssh:)/i.test(source)) return false;

	try {
		// isAbsolute 同时认 POSIX 与 Windows 盘符两种形态（win32 join 不会用
		// 绝对路径替换前缀，直接 join 会拼出畸形路径）；normalize 统一斜杠方向。
		const resolved = normalize(isAbsolute(source) ? source : join(baseDir, source));
		return resolved === self.dir;
	} catch {
		return false;
	}
}

function resolveSelfPackage(): SelfPackageIdentity | undefined {
	// 从本文件位置逐级向上找声明了 pi.extensions 的 package.json。
	// 源码场景下本文件在包根的 modules/tui/plugin/ 里（四层深），组装后的产物
	// 可能在更浅的位置，因此向上多探几层而不是写死深度。
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let i = 0; i < 8; i += 1) {
		const manifest = join(dir, "package.json");
		if (existsSync(manifest)) {
			try {
				const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
					name?: unknown;
					pi?: { extensions?: unknown[] };
					repository?: string | { url?: unknown };
				};
				if (parsed.pi?.extensions && typeof parsed.name === "string") {
					const repositoryUrl = typeof parsed.repository === "string"
						? parsed.repository
						: (typeof parsed.repository?.url === "string" ? parsed.repository.url : undefined);
					return {
						dir: normalize(dir),
						name: parsed.name,
						repository: repositoryUrl ? gitRepositoryIdentity(repositoryUrl) : undefined,
					};
				}
			} catch { /* 继续向上 */ }
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
	return undefined;
}

export interface PackageOrderResult {
	adjusted: boolean;
	reason?: string;
}

/** 检查并调整本插件在 packages 中的位置到首位；任何失败都不抛出。 */
export function ensureFirstPackage(agentDir: string, env: Readonly<Record<string, string | undefined>> = process.env): PackageOrderResult {
	if (env.PI_TOOLKIT_KEEP_PACKAGE_ORDER === "1") return { adjusted: false, reason: "disabled-env" };
	const settingsPath = join(agentDir, "settings.json");
	try {
		const raw = readFileSync(settingsPath, "utf8");
		const settings = JSON.parse(raw) as {
			packages?: unknown[];
			piToolkitKeepPackageOrder?: boolean;
		};
		if (settings.piToolkitKeepPackageOrder === true) return { adjusted: false, reason: "disabled-settings" };
		const packages = settings.packages;
		if (!Array.isArray(packages) || packages.length < 2) return { adjusted: false };
		const self = resolveSelfPackage();
		if (!self) return { adjusted: false, reason: "self-not-found" };
		const index = packages.findIndex((entry) => isSelfEntry(entry, self, agentDir));
		if (index <= 0) return { adjusted: false };
		const next = [...packages];
		const [selfEntry] = next.splice(index, 1);
		next.unshift(selfEntry);
		settings.packages = next;
		const tmpPath = `${settingsPath}.pi-toolkit.tmp`;
		writeFileSync(tmpPath, JSON.stringify(settings, null, "\t") + "\n");
		renameSync(tmpPath, settingsPath);
		return { adjusted: true };
	} catch {
		return { adjusted: false, reason: "error" };
	}
}
