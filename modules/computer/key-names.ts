// 键名预校验镜像（工单 31）：与 native/src/input.rs 的 parse_key/parse_keys、非空判定和
// system_combo_reason 保持同义，另同步 Rust char::is_whitespace 的 trim 字符集；改一处必须同步另一处。
//
// 为什么 TS 侧还要一份：helper 的键名校验在 act 层（plan_actions 对一次 act 的整批前置判定），
// 而 computer_run 是逐步派发 act——非法键名要到那一步派发时才炸，前几步的副作用已经落地
// （工单 31 真机验收抓到的半批执行：step1 的 7 已经敲进计算器，step2 的 "+" 才被拒）。
// 工具层在 PRE-BATCH 冻结阶段用这份镜像先解析全部 keypress 的 keys，任何一个非法整批拒绝、零副作用。
//
// 语义与 native 逐项同义：+ 分隔组合、空组件拒绝、具名键目录、单字符字面（大小写归一到小写，
// 字符面交给应用）、plus 别名（'+' 是组合分隔符，单写进不了组合语法）、别名匹配按 ASCII 大写归一
// （与 Rust 的 to_ascii_uppercase 同口径，非 ASCII 字符不参与别名匹配）、非空 keys 与系统键黑名单。
// 错误文案与 helper 的 parse_keys/system_combo_reason 同口径（含 "combinations use + between key names"）。
//
// 本文件只有纯逻辑：不碰后端、不碰状态层，任何平台可测。

/** 具名键的规范名（目录照抄 native/src/input.rs 的 parse_key；capslock/numlock/printscreen 不在目录里） */
export type ComputerNamedKeyName =
  | "ctrl"
  | "shift"
  | "alt"
  | "meta"
  | "enter"
  | "escape"
  | "tab"
  | "space"
  | "backspace"
  | "delete"
  | "insert"
  | "home"
  | "end"
  | "pageup"
  | "pagedown"
  | "up"
  | "down"
  | "left"
  | "right";

/** 一个解析好的键：具名键、功能键（F1–F24）或单字符键 */
export type ComputerKey =
  | { readonly kind: "named"; readonly name: ComputerNamedKeyName }
  | { readonly kind: "function"; readonly index: number }
  | { readonly kind: "character"; readonly character: string };

/** 别名表：ASCII 大写归一后的名字 → 具名键（与 native/src/input.rs 的 parse_key 逐条对应） */
const NAMED_KEY_ALIASES: Readonly<Record<string, ComputerNamedKeyName>> = {
  CTRL: "ctrl",
  CONTROL: "ctrl",
  SHIFT: "shift",
  ALT: "alt",
  OPTION: "alt",
  META: "meta",
  CMD: "meta",
  COMMAND: "meta",
  SUPER: "meta",
  WIN: "meta",
  WINDOWS: "meta",
  ENTER: "enter",
  RETURN: "enter",
  ESC: "escape",
  ESCAPE: "escape",
  TAB: "tab",
  SPACE: "space",
  BACKSPACE: "backspace",
  DELETE: "delete",
  DEL: "delete",
  INSERT: "insert",
  HOME: "home",
  END: "end",
  PAGEUP: "pageup",
  PAGEDOWN: "pagedown",
  UP: "up",
  ARROWUP: "up",
  DOWN: "down",
  ARROWDOWN: "down",
  LEFT: "left",
  ARROWLEFT: "left",
  RIGHT: "right",
  ARROWRIGHT: "right",
};

/** ASCII 小写 → 大写（与 Rust 的 to_ascii_uppercase 同口径：非 ASCII 原样保留） */
function asciiUppercase(value: string): string {
  return value.replace(/[a-z]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x20));
}

// Rust 的 char::is_whitespace 不修 U+FEFF；不能用 String.trim()，它会额外修剪该字符。
const rustTrim = (value: string): string =>
  value.replace(
    /^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/gu,
    "",
  );

/**
 * 解析一个键名：别名不分大小写、容忍两端空白；单字符按原字符归一到小写。
 * 表外名字（含多字符的陌生词）回 undefined，调用方回 invalid_params。
 */
export function parseComputerKey(value: string): ComputerKey | undefined {
  const trimmed = rustTrim(value);
  const normalized = asciiUppercase(trimmed);
  const named = NAMED_KEY_ALIASES[normalized];
  if (named !== undefined) return { kind: "named", name: named };
  // 加号字符（工单 31）：'+' 是组合分隔符，单写进不了组合语法；不用 vk 0xBB+shift 合成
  // （布局相关、语义模糊），按单字符 '+' 走 Unicode 注入、字符面交给应用——与 native 同一别名
  if (normalized === "PLUS") return { kind: "character", character: "+" };
  if (normalized.startsWith("F")) {
    const rest = normalized.slice(1);
    if (rest !== "") {
      if (/^\d+$/.test(rest)) {
        const index = Number(rest);
        // F04 这类补零写法不认：正规写法是 F4
        if (index >= 1 && index <= 24 && String(index) === rest) return { kind: "function", index };
      }
      // F0、F25、F04、Fx 这类：不是功能键，也不是单字符（rest 非空），直接拒
      return undefined;
    }
    // 单独一个 F 是单字符 'f'，落到下面的单字符分支
  }
  const characters = [...trimmed];
  if (characters.length !== 1) return undefined;
  // 大小写归一：按键的字符面交给应用（CapsLock/Shift 状态叠加在它之上）；
  // 个别字符小写后会展开成多字符（如 İ），与 Rust 的 to_lowercase().next() 同口径取第一个
  const lowered = [...characters[0].toLowerCase()];
  return { kind: "character", character: lowered[0] ?? characters[0] };
}

/** 键名组合串的解析结果：成功给摊平后的按下序列，失败给与 helper 同口径的错误文案 */
export type ComputerKeyEntriesResult =
  | { readonly ok: true; readonly keys: readonly ComputerKey[] }
  | { readonly ok: false; readonly message: string };

/**
 * 解析 keypress 的 keys：每条用 + 分隔、可多条，整串摊平成一个按下序列。
 * 错误文案与 native/src/input.rs 的 parse_keys 保持一致，保证工具层预校验与 helper 派发期
 * 报给模型的是同一句话。
 */
export function parseComputerKeyEntries(entries: readonly string[]): ComputerKeyEntriesResult {
  if (entries.length === 0) return { ok: false, message: "keypress needs a non-empty keys array" };
  const keys: ComputerKey[] = [];
  for (const entry of entries) {
    for (const component of entry.split("+")) {
      if (rustTrim(component) === "") {
        return {
          ok: false,
          message:
            `empty key component in keypress entry ${JSON.stringify(entry)}: ` +
            "combinations use + between key names",
        };
      }
      const key = parseComputerKey(component);
      if (key === undefined) {
        return {
          ok: false,
          message:
            `unsupported key name ${JSON.stringify(rustTrim(component))}: known names are ctrl, shift, alt, ` +
            "meta (win), enter, escape, tab, space, backspace, delete, insert, home, end, pageup, " +
            "pagedown, up, down, left, right, f1-f24, plus or a single character",
        };
      }
      keys.push(key);
    }
  }
  const hasNamed = (name: ComputerNamedKeyName): boolean =>
    keys.some((key) => key.kind === "named" && key.name === name);
  const hasFunction = (index: number): boolean =>
    keys.some((key) => key.kind === "function" && key.index === index);
  if (hasNamed("meta")) {
    return { ok: false, message: "system key combination rejected: the Windows key is a system key and is not allowed, alone or in any combination" };
  }
  if (hasNamed("ctrl") && hasNamed("alt") && hasNamed("delete")) {
    return { ok: false, message: "system key combination rejected: Ctrl+Alt+Del is a system key combination and is not allowed" };
  }
  if (hasNamed("alt") && hasFunction(4)) {
    return { ok: false, message: "system key combination rejected: Alt+F4 closes applications and is not allowed" };
  }
  if (hasNamed("alt") && hasNamed("tab")) {
    return { ok: false, message: "system key combination rejected: Alt+Tab switches applications and is not allowed" };
  }
  if (hasNamed("ctrl") && hasNamed("shift") && hasNamed("escape")) {
    return { ok: false, message: "system key combination rejected: Ctrl+Shift+Esc opens the task manager and is not allowed" };
  }
  if (hasNamed("ctrl") && hasNamed("escape")) {
    return { ok: false, message: "system key combination rejected: Ctrl+Esc opens the start menu and is not allowed" };
  }
  return { ok: true, keys };
}
