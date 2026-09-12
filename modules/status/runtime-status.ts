// status 模块数据源：项目运行时探测（从 tui/status/ 整体迁入，工单 11）。
//
// 版本命令探测、目录指纹缓存与刷新控制器都归数据模块；`status.workspace` 快照里
// 的 runtime 段由本文件的控制器提供。重绘节奏归 tui（工单 18）：控制器不持重绘回调，
// 数据变化由快照内容比较带出变更序号，tui 心跳按序号变化重绘。

import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";

const CACHE_LIMIT = 32;
// 暂时不可用的版本命令需要恢复机会，也不能在密集刷新时反复启动进程。
const VERSION_RETRY_MS = 30_000;
const RUNTIME_ENV_KEYS = [
	"PATH",
	"Path",
	"PATHEXT",
	"NVM_BIN",
	"NVM_SYMLINK",
	"VOLTA_HOME",
	"ASDF_DIR",
	"MISE_ENV_FILE",
	"PYENV_VERSION",
	"VIRTUAL_ENV",
] as const;

export interface RuntimeStatusSnapshot {
	name: string;
	version?: string;
}

export interface RuntimeVersionResult {
	stdout: string;
	stderr: string;
	code: number | null;
	killed: boolean;
}

export type RuntimeVersionQuery = (
	command: string,
	args: readonly string[],
	cwd: string,
	signal: AbortSignal,
) => Promise<RuntimeVersionResult>;

export type RuntimeStatusQuery = (
	cwd: string,
	signal: AbortSignal,
) => Promise<RuntimeStatusSnapshot | null | undefined>;

interface RuntimeDefinition {
	id: string;
	name: string;
	files?: readonly string[];
	folders?: readonly string[];
	extensions?: readonly string[];
	env?: string;
	version?: {
		command: string;
		args: readonly string[];
		pattern: RegExp;
	};
}

const RUNTIMES: readonly RuntimeDefinition[] = [
	{ id: "nodejs", name: "Node.js", files: ["package.json", ".nvmrc", ".node-version"], version: { command: "node", args: ["--version"], pattern: /v(\d+\.\d+\.\d+)/ } },
	{ id: "rust", name: "Rust", files: ["Cargo.toml"], version: { command: "rustc", args: ["--version"], pattern: /rustc\s+(\d+\.\d+\.\d+)/ } },
	{ id: "go", name: "Go", files: ["go.mod"], version: { command: "go", args: ["version"], pattern: /go(\d+\.\d+(?:\.\d+)?)/ } },
	{ id: "python", name: "Python", files: ["pyproject.toml", "requirements.txt", "setup.py", "Pipfile", ".python-version"], version: { command: process.platform === "win32" ? "python" : "python3", args: ["--version"], pattern: /Python\s+(\d+\.\d+\.\d+)/ } },
	{ id: "ruby", name: "Ruby", files: ["Gemfile", ".ruby-version"], version: { command: "ruby", args: ["--version"], pattern: /ruby\s+(\d+\.\d+\.\d+)/ } },
	{ id: "java", name: "Java", files: ["pom.xml", "build.gradle", "build.gradle.kts", ".java-version"], version: { command: "java", args: ["-version"], pattern: /version\s+"(\d+\.\d+[.\d]*)"/ } },
	{ id: "swift", name: "Swift", files: ["Package.swift"], version: { command: "swift", args: ["--version"], pattern: /Swift\s+(\d+\.\d+(?:\.\d+)?)/ } },
	{ id: "kotlin", name: "Kotlin", files: ["settings.gradle.kts"] },
	{ id: "deno", name: "Deno", files: ["deno.json", "deno.jsonc", "deno.lock"], version: { command: "deno", args: ["--version"], pattern: /deno\s+(\d+\.\d+\.\d+)/ } },
	{ id: "bun", name: "Bun", files: ["bun.lock", "bun.lockb"], version: { command: "bun", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ id: "php", name: "PHP", files: ["composer.json"], version: { command: "php", args: ["--version"], pattern: /PHP\s+(\d+\.\d+\.\d+)/ } },
	{ id: "haskell", name: "Haskell", files: ["stack.yaml", "cabal.project"], extensions: [".cabal"], version: { command: "ghc", args: ["--version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ id: "julia", name: "Julia", files: ["Project.toml", "Manifest.toml"], version: { command: "julia", args: ["--version"], pattern: /julia\s+(\d+\.\d+\.\d+)/i } },
	{ id: "lua", name: "Lua", files: ["stylua.toml", ".luarc.json"], version: { command: "lua", args: ["-v"], pattern: /Lua\s+(\d+\.\d+(?:\.\d+)?)/ } },
	{ id: "elixir", name: "Elixir", files: ["mix.exs"], version: { command: "elixir", args: ["--version"], pattern: /Elixir\s+(\d+\.\d+\.\d+)/ } },
	{ id: "erlang", name: "Erlang", files: ["rebar.config", "erlang.mk"] },
	{ id: "gleam", name: "Gleam", files: ["gleam.toml"], version: { command: "gleam", args: ["--version"], pattern: /gleam\s+(\d+\.\d+\.\d+)/i } },
	{ id: "crystal", name: "Crystal", files: ["shard.yml"], version: { command: "crystal", args: ["--version"], pattern: /Crystal\s+(\d+\.\d+\.\d+)/ } },
	{ id: "dart", name: "Dart", files: ["pubspec.yaml"], version: { command: "dart", args: ["--version"], pattern: /Dart\s+SDK\s+version:\s+(\d+\.\d+\.\d+)/ } },
	{ id: "nim", name: "Nim", files: ["nim.cfg"], extensions: [".nimble"] },
	{ id: "zig", name: "Zig", files: ["build.zig"], version: { command: "zig", args: ["version"], pattern: /(\d+\.\d+\.\d+)/ } },
	{ id: "ocaml", name: "OCaml", files: ["dune", "dune-project"], extensions: [".opam"] },
	{ id: "clojure", name: "Clojure", files: ["project.clj", "deps.edn"] },
	{ id: "scala", name: "Scala", files: ["build.sbt"], folders: [".metals"] },
	{ id: "perl", name: "Perl", files: ["Makefile.PL", "cpanfile"] },
	{ id: "r", name: "R", files: ["DESCRIPTION"], extensions: [".Rproj"] },
	{ id: "elm", name: "Elm", files: ["elm.json"] },
	{ id: "haxe", name: "Haxe", files: ["haxelib.json", ".haxerc"] },
	{ id: "vagrant", name: "Vagrant", files: ["Vagrantfile"] },
	{ id: "terraform", name: "Terraform", files: ["main.tf", "variables.tf"], folders: [".terraform"] },
	{ id: "helm", name: "Helm", files: ["Chart.yaml", "helmfile.yaml"] },
	{ id: "solidity", name: "Solidity", extensions: [".sol"] },
	{ id: "fortran", name: "Fortran", files: ["fpm.toml"], extensions: [".f", ".f90", ".f95"] },
	{ id: "mojo", name: "Mojo", extensions: [".mojo"] },
	{ id: "red", name: "Red", extensions: [".red", ".reds"] },
	{ id: "raku", name: "Raku", files: ["META6.json"], extensions: [".raku", ".rakumod"] },
	{ id: "purescript", name: "PureScript", files: ["spago.dhall", "spago.yaml"] },
	{ id: "fennel", name: "Fennel", extensions: [".fnl"] },
	{ id: "odin", name: "Odin", extensions: [".odin"] },
	{ id: "v", name: "V", files: ["v.mod", "vpkg.json"], extensions: [".v"] },
	{ id: "xmake", name: "xmake", files: ["xmake.lua"] },
	{ id: "gradle", name: "Gradle", files: ["build.gradle", "build.gradle.kts"], folders: ["gradle"] },
	{ id: "maven", name: "Maven", files: ["pom.xml"] },
	{ id: "cmake", name: "CMake", files: ["CMakeLists.txt", "CMakeCache.txt"] },
	{ id: "meson", name: "Meson", files: ["meson.build"], env: "MESON_DEVENV" },
	{ id: "nix", name: "Nix", files: ["flake.nix", "shell.nix"], env: "IN_NIX_SHELL" },
	{ id: "guix", name: "Guix", env: "GUIX_ENVIRONMENT" },
	{ id: "conda", name: "Conda", env: "CONDA_DEFAULT_ENV" },
	{ id: "pixi", name: "Pixi", files: ["pixi.toml", "pixi.lock"], env: "PIXI_ENVIRONMENT_NAME" },
	{ id: "spack", name: "Spack", env: "SPACK_ENV" },
	{ id: "pulumi", name: "Pulumi", files: ["Pulumi.yaml", "Pulumi.yml"] },
	{ id: "typst", name: "Typst", files: ["template.typ"], extensions: [".typ"] },
	{ id: "buf", name: "Buf", files: ["buf.yaml", "buf.gen.yaml", "buf.work.yaml"] },
	{ id: "dotnet", name: ".NET", files: ["global.json", "Directory.Build.props"], extensions: [".csproj", ".fsproj"] },
	{ id: "cobol", name: "COBOL", extensions: [".cbl", ".cob"] },
	{ id: "cpp", name: "C++", files: ["CMakeLists.txt"], extensions: [".cpp", ".cc", ".cxx"] },
	{ id: "c", name: "C", files: ["Makefile"], extensions: [".c"] },
] as const;

interface RuntimeCacheEntry {
	fingerprint: string;
	value: RuntimeStatusSnapshot;
	retryAt?: number;
}

function matchesRuntime(
	definition: RuntimeDefinition,
	entries: ReadonlyMap<string, boolean>,
	env: Readonly<Record<string, string | undefined>>,
): boolean {
	if (definition.env && env[definition.env]) return true;
	if (definition.files?.some((name) => entries.has(name))) return true;
	if (definition.folders?.some((name) => entries.get(name) === true)) return true;
	return definition.extensions?.some((extension) =>
		[...entries.keys()].some((name) => name.endsWith(extension))) ?? false;
}

async function runtimeFingerprint(
	cwd: string,
	definition: RuntimeDefinition,
	entryNames: readonly string[],
	env: Readonly<Record<string, string | undefined>>,
): Promise<string> {
	const parts = [`runtime:${definition.id}`, ...entryNames.slice().sort()];
	for (const name of definition.files ?? []) {
		if (!entryNames.includes(name)) continue;
		try {
			parts.push(`${name}:${(await stat(join(cwd, name))).mtimeMs}`);
		} catch {
			// 列目录和读取元数据之间文件可能被删除，下轮刷新会重新判断。
		}
	}
	if (definition.env && env[definition.env]) {
		parts.push(`${definition.env}=${env[definition.env]}`);
	}
	for (const name of RUNTIME_ENV_KEYS) {
		if (env[name]) parts.push(`${name}=${env[name]}`);
	}
	return parts.join("\0");
}

async function readVersion(
	definition: RuntimeDefinition,
	cwd: string,
	queryVersion: RuntimeVersionQuery,
	signal: AbortSignal,
): Promise<string | undefined> {
	if (!definition.version) return undefined;
	try {
		const result = await queryVersion(
			definition.version.command,
			definition.version.args,
			cwd,
			signal,
		);
		signal.throwIfAborted();
		if (result.killed || result.code !== 0) return undefined;
		const match = `${result.stdout}\n${result.stderr}`.match(definition.version.pattern);
		return match?.[1];
	} catch (error) {
		if (signal.aborted) throw error;
		return undefined;
	}
}

// 缓存与查询适配器一起归调用方持有，避免新会话或新适配器沿用旧结果。
export function createRuntimeStatusDetector(
	queryVersion: RuntimeVersionQuery,
	env: Readonly<Record<string, string | undefined>> = process.env,
	now: () => number = Date.now,
): RuntimeStatusQuery {
	const cache = new Map<string, RuntimeCacheEntry>();
	return async (cwd, signal) => {
		signal.throwIfAborted();
		let directoryEntries;
		try {
			directoryEntries = await readdir(cwd, { withFileTypes: true });
		} catch {
			return null;
		}
		signal.throwIfAborted();
		const entries = new Map(directoryEntries.map((entry) => [entry.name, entry.isDirectory()]));
		const definition = RUNTIMES.find((candidate) => matchesRuntime(candidate, entries, env));
		if (!definition) return null;

		const fingerprint = await runtimeFingerprint(cwd, definition, [...entries.keys()], env);
		signal.throwIfAborted();
		const cached = cache.get(cwd);
		if (cached?.fingerprint === fingerprint && (cached.retryAt === undefined || now() < cached.retryAt)) {
			return cached.value;
		}

		const version = await readVersion(definition, cwd, queryVersion, signal);
		const value: RuntimeStatusSnapshot = {
			name: definition.name,
			...(version ? { version } : {}),
		};
		cache.delete(cwd);
		cache.set(cwd, {
			fingerprint,
			value,
			...(definition.version && !version ? { retryAt: now() + VERSION_RETRY_MS } : {}),
		});
		while (cache.size > CACHE_LIMIT) {
			const oldest = cache.keys().next().value;
			if (oldest === undefined) break;
			cache.delete(oldest);
		}
		return value;
	};
}

export class RuntimeStatusController {
	private readonly cwd: string;
	private readonly queryRuntimeStatus: RuntimeStatusQuery;
	private readonly debounceMs: number;
	private snapshot: RuntimeStatusSnapshot | null = null;
	private refreshTimer: ReturnType<typeof setTimeout> | undefined;
	private refreshInFlight = false;
	private refreshPending = false;
	private abortController: AbortController | undefined;
	private disposed = false;

	constructor(cwd: string, queryRuntimeStatus: RuntimeStatusQuery, debounceMs = 120) {
		this.cwd = cwd;
		this.queryRuntimeStatus = queryRuntimeStatus;
		this.debounceMs = debounceMs;
	}

	/** 开始查询；数据变化由 `status.workspace` 快照的变更序号带出，控制器不触发重绘 */
	connect(): void {
		if (this.disposed) return;
		this.requestRefresh(0);
	}

	getSnapshot(): RuntimeStatusSnapshot | null {
		return this.snapshot;
	}

	requestRefresh(delay = this.debounceMs): void {
		if (this.disposed || this.refreshTimer) return;
		if (this.refreshInFlight) {
			this.refreshPending = true;
			return;
		}
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, delay);
	}

	async refresh(): Promise<void> {
		if (this.disposed || this.refreshInFlight) return;
		this.refreshInFlight = true;
		const abortController = new AbortController();
		this.abortController = abortController;
		try {
			const result = await this.queryRuntimeStatus(this.cwd, abortController.signal);
			if (this.disposed || result === undefined) return;
			this.snapshot = result;
		} catch {
			// 查询失败时保留最后一次已识别结果，不让状态行闪烁。
		} finally {
			if (this.abortController === abortController) this.abortController = undefined;
			this.refreshInFlight = false;
			if (this.refreshPending && !this.disposed) {
				this.refreshPending = false;
				this.requestRefresh(0);
			}
		}
	}

	dispose(): void {
		this.disposed = true;
		if (this.refreshTimer) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
		this.abortController?.abort();
		this.abortController = undefined;
	}
}
