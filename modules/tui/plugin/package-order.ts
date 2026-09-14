// 包顺序自调：Pi 的 packages 按数组顺序串行加载，且 pi install 固定 append 到
// 末尾——本包含 TUI 外观类扩展，需要尽早加载（闸门/看门狗越早挂，宿主与其
// 它扩展的初始化输出越少暴露）。检测到不在首位时调整一次并写回 + 通知。
// 幂等且可退出：已在首位零动作；settings 里 piToolkitKeepPackageOrder=true 或
// 环境变量 PI_TOOLKIT_KEEP_PACKAGE_ORDER=1 时永不调整；写回失败静默放弃。
//
// 迁入 pi-toolkit 后按新包名适配（保留行为，只换标识）：原 pi-tui 的
// `piTuiKeepPackageOrder` / `PI_TUI_KEEP_PACKAGE_ORDER` 不再识别；识别目标
// 也从 pi-tui 包换成声明 `pi.extensions` 的本包（pi-toolkit）。
//
// 工单 31 修复：git 形态条目的身份匹配此前只认 package.json 的 repository 字段，
// 而发布清单从未声明过该字段，导致 git 安装（生产主形态）永不自调。现在身份
// 解析三级兜底：清单 repository → 安装树 .git/config 的 remote origin → 宿主
// git 安装布局反推；读取 settings.json 时剥离 BOM（与宿主一致）；本地路径比较
// 对 Windows 盘符路径做大小写不敏感匹配；写回缩进对齐宿主的 2 空格，失败时
// 清理残留 tmp 文件。

import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";
import { fileURLToPath } from "node:url";

interface GitRepositoryIdentity {
	host: string;
	path: string;
}

interface SelfPackageIdentity {
	dir: string;
	name: string;
	/** pi.extensions 声明的入口文件（解析到 dir 下的绝对路径），覆盖按入口文件安装的本地条目 */
	entryFiles: string[];
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

/** 从 .git/config 里解析 remote "origin" 的 URL（git 克隆安装的身份兜底；best-effort） */
function gitOriginUrlFromConfig(configPath: string): string | undefined {
	try {
		let inOrigin = false;
		for (const line of readFileSync(configPath, "utf8").split(/\r?\n/)) {
			const section = line.match(/^\s*\[(.+?)\]/);
			if (section) {
				inOrigin = /^remote\s+"origin"$/.test(section[1]!.trim());
				continue;
			}
			if (!inOrigin) continue;
			const url = line.match(/^\s*url\s*=\s*(.+?)\s*$/);
			if (url) return url[1];
		}
	} catch {
		/* 无 .git 或不可读：交给上层返回 undefined */
	}
	return undefined;
}

/**
 * 从宿主的 git 安装目录布局（<agentDir>/git/<host>/<owner>/<repo>）反推仓库身份。
 * pi 的 git 安装固定落在该布局下；只对 agentDir 下的 git 根生效，避免把任意
 * 本地安装目录误认成 git 仓库（win32 relative 本身大小写不敏感）。
 */
function gitIdentityFromInstallLayout(dir: string, agentDir: string): GitRepositoryIdentity | undefined {
	try {
		const rel = relative(normalize(join(agentDir, "git")), normalize(dir));
		if (!rel || rel.startsWith("..") || isAbsolute(rel)) return undefined;
		return gitRepositoryIdentity(`git:${rel.replaceAll("\\", "/")}`);
	} catch {
		return undefined;
	}
}

function isWindowsDrivePath(value: string): boolean {
	return /^[a-zA-Z]:[\\/]/.test(value);
}

/** 本地安装路径等价判断：先精确比较；两侧都是 Windows 盘符路径时大小写不敏感 */
function sameInstallPath(left: string, right: string): boolean {
	if (left === right) return true;
	if (isWindowsDrivePath(left) && isWindowsDrivePath(right)) return left.toLowerCase() === right.toLowerCase();
	return false;
}

/** 判断 packages 项是否指向本插件（本地路径、npm 名称或 Git 仓库）。 */
function isSelfEntry(entry: unknown, self: SelfPackageIdentity, baseDir: string): boolean {
	const source = entrySource(entry);
	if (!source) return false;

	const npmName = npmPackageName(source);
	if (npmName) return npmName.toLowerCase() === self.name.toLowerCase();

	const repository = gitRepositoryIdentity(source);
	if (repository) {
		return repository.host === self.repository?.host && repository.path === self.repository?.path;
	}
	if (/^(?:git:|https?:|ssh:)/i.test(source)) return false;

	try {
		// isAbsolute 同时认 POSIX 与 Windows 盘符两种形态（win32 join 不会用
		// 绝对路径替换前缀，直接 join 会拼出畸形路径）；normalize 统一斜杠方向。
		const resolved = normalize(isAbsolute(source) ? source : join(baseDir, source));
		// 目录条目（pi install <dir>）比包根；文件条目（pi install <dir>/index.ts）
		// 比声明过的 pi.extensions 入口文件。
		return sameInstallPath(resolved, self.dir)
			|| self.entryFiles.some((file) => sameInstallPath(resolved, file));
	} catch {
		return false;
	}
}

function resolveSelfPackage(agentDir: string): SelfPackageIdentity | undefined {
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
					// 工单 31：发布清单长期没有 repository 字段（npm/git 安装都拿不到），git 身份
					// 改为三级兜底——清单 repository → 安装树 .git/config 的 remote origin →
					// 宿主 git 安装布局（<agentDir>/git/<host>/<path>）反推。
					// 工单 32：声明存在但解析不了（如畸形 URL）时同样逐级落后，不能因声明非空
					// 就跳过 .git/config 兜底。
					const declared = gitRepositoryIdentity(repositoryUrl ?? "")
						?? gitRepositoryIdentity(gitOriginUrlFromConfig(join(dir, ".git", "config")) ?? "");
					const fromLayout = declared ? undefined : gitIdentityFromInstallLayout(dir, agentDir);
					const entryFiles = parsed.pi.extensions
						.filter((entry): entry is string => typeof entry === "string")
						.map((entry) => normalize(join(dir, entry)));
					return {
						dir: normalize(dir),
						name: parsed.name,
						entryFiles,
						repository: declared ?? fromLayout,
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
		// 宿主读取 settings 一律剥 BOM（stripBom）；带 BOM 的文件直接 JSON.parse
		// 会抛错，曾经把整条自调链路静默吞掉（工单 31）。
		const raw = readFileSync(settingsPath, "utf8");
		const settings = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as {
			packages?: unknown[];
			piToolkitKeepPackageOrder?: boolean;
		};
		if (settings.piToolkitKeepPackageOrder === true) return { adjusted: false, reason: "disabled-settings" };
		const packages = settings.packages;
		if (!Array.isArray(packages) || packages.length < 2) return { adjusted: false };
		const self = resolveSelfPackage(agentDir);
		if (!self) return { adjusted: false, reason: "self-not-found" };
		const index = packages.findIndex((entry) => isSelfEntry(entry, self, agentDir));
		if (index <= 0) return { adjusted: false };
		const next = [...packages];
		const [selfEntry] = next.splice(index, 1);
		next.unshift(selfEntry);
		settings.packages = next;
		// 缩进对齐宿主 settings-manager 的 2 空格，避免整文件重排。
		const tmpPath = `${settingsPath}.pi-toolkit.tmp`;
		try {
			writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n");
			renameSync(tmpPath, settingsPath);
		} catch (error) {
			// 写回失败静默放弃，但清掉刚写出的 tmp，不给用户目录留残骸。
			try {
				rmSync(tmpPath, { force: true });
			} catch { /* 清理也失败：维持静默 */ }
			throw error;
		}
		return { adjusted: true };
	} catch {
		return { adjusted: false, reason: "error" };
	}
}
