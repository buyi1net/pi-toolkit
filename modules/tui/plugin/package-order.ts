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

	}
	return undefined;
}

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

function sameInstallPath(left: string, right: string): boolean {
	if (left === right) return true;
	if (isWindowsDrivePath(left) && isWindowsDrivePath(right)) return left.toLowerCase() === right.toLowerCase();
	return false;
}

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

		const resolved = normalize(isAbsolute(source) ? source : join(baseDir, source));

		return sameInstallPath(resolved, self.dir)
			|| self.entryFiles.some((file) => sameInstallPath(resolved, file));
	} catch {
		return false;
	}
}

function resolveSelfPackage(agentDir: string): SelfPackageIdentity | undefined {

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

export function ensureFirstPackage(agentDir: string, env: Readonly<Record<string, string | undefined>> = process.env): PackageOrderResult {
	if (env.PI_TOOLKIT_KEEP_PACKAGE_ORDER === "1") return { adjusted: false, reason: "disabled-env" };
	const settingsPath = join(agentDir, "settings.json");
	try {

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

		const tmpPath = `${settingsPath}.pi-toolkit.tmp`;
		try {
			writeFileSync(tmpPath, JSON.stringify(settings, null, 2) + "\n");
			renameSync(tmpPath, settingsPath);
		} catch (error) {

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
