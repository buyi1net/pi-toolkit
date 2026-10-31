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

export type ComputerKey =
  | { readonly kind: "named"; readonly name: ComputerNamedKeyName }
  | { readonly kind: "function"; readonly index: number }
  | { readonly kind: "character"; readonly character: string };

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

function asciiUppercase(value: string): string {
  return value.replace(/[a-z]/g, (character) => String.fromCharCode(character.charCodeAt(0) - 0x20));
}

const rustTrim = (value: string): string =>
  value.replace(
    /^[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+|[\u0009-\u000D\u0020\u0085\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000]+$/gu,
    "",
  );

export function parseComputerKey(value: string): ComputerKey | undefined {
  const trimmed = rustTrim(value);
  const normalized = asciiUppercase(trimmed);
  const named = NAMED_KEY_ALIASES[normalized];
  if (named !== undefined) return { kind: "named", name: named };

  if (normalized === "PLUS") return { kind: "character", character: "+" };
  if (normalized.startsWith("F")) {
    const rest = normalized.slice(1);
    if (rest !== "") {
      if (/^\d+$/.test(rest)) {
        const index = Number(rest);

        if (index >= 1 && index <= 24 && String(index) === rest) return { kind: "function", index };
      }

      return undefined;
    }

  }
  const characters = [...trimmed];
  if (characters.length !== 1) return undefined;

  const lowered = [...characters[0].toLowerCase()];
  return { kind: "character", character: lowered[0] ?? characters[0] };
}

export type ComputerKeyEntriesResult =
  | { readonly ok: true; readonly keys: readonly ComputerKey[] }
  | { readonly ok: false; readonly message: string };

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
