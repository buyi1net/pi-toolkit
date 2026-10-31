const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  "#39": "'",
  "#x27": "'",
  "#x2F": "/",
};

function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    const named = NAMED_ENTITIES[entity];
    if (named !== undefined) return named;
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return whole;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      if (Number.isInteger(code) && code > 0 && code <= 0x10ffff) return String.fromCodePoint(code);
      return whole;
    }
    return whole;
  });
}

export function htmlToText(html: string): string {
  let text = html;

  text = text.replace(/<(script|style|noscript|template|svg|head)\b[^>]*>[\s\S]*?<\/\1>/gi, " ");
  text = text.replace(/<!--[\s\S]*?-->/g, " ");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre|table|ul|ol|dl|dd|dt|nav|footer|header)\s*>/gi, "\n");

  text = text.replace(/<[^>]+>/g, " ");
  text = decodeEntities(text);

  text = text.replace(/[ \t\f\v]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/[ \t]+\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

export function decodeDuckRedirect(href: string): string | null {
  try {
    const raw = href.trim();
    const url = new URL(raw, "https://duckduckgo.com");
    if (url.hostname !== "duckduckgo.com" || url.pathname !== "/l/") return null;
    const target = url.searchParams.get("uddg");
    if (!target) return null;
    const decoded = new URL(target);
    return decoded.protocol === "http:" || decoded.protocol === "https:" ? decoded.toString() : null;
  } catch {
    return null;
  }
}

export function urlForMessage(rawUrl: string): string {
  const head = rawUrl.split(/[?#]/, 1)[0]!;
  return head.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^/@]*@/i, "$1");
}

function isPrivateIpv4(host: string): boolean {
  if (/^127\./.test(host)) return true;
  if (/^10\./.test(host)) return true;
  if (/^192\.168\./.test(host)) return true;
  if (/^169\.254\./.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
  return /^(0\.|255\.)/.test(host);
}

function embeddedIpv4(host: string): string | undefined {
  const tail = host.startsWith("::ffff:") ? host.slice(7) : host.startsWith("::") ? host.slice(2) : undefined;
  if (tail === undefined) return undefined;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(tail)) return tail;
  const last = tail.split(":").slice(-2);
  if (last.length !== 2 || !last.every((group) => /^[0-9a-f]{1,4}$/.test(group))) return undefined;
  const high = Number.parseInt(last[0]!, 16);
  const low = Number.parseInt(last[1]!, 16);
  return [high >> 8, high & 0xff, low >> 8, low & 0xff].join(".");
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return true;
  }
  if (host === "::1" || host === "0:0:0:0:0:0:0:1") return true;
  if (host.startsWith("fe80:") || host.startsWith("fc") || host.startsWith("fd")) return true;
  const embedded = embeddedIpv4(host);
  if (embedded !== undefined) return isPrivateIpv4(embedded);
  if (isPrivateIpv4(host)) return true;

  if (host === "metadata.google.internal") return true;
  return false;
}

export function assertFetchableUrl(rawUrl: string): string | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return `Invalid URL: ${urlForMessage(rawUrl)}`;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return `Unsupported protocol "${url.protocol}" — only http/https URLs can be fetched.`;
  }
  if (url.username || url.password) {
    return "URLs with embedded credentials are refused.";
  }
  if (isPrivateHost(url.hostname)) {
    return (
      `Refusing to fetch internal/loopback address "${url.hostname}" — only public http(s) targets are allowed.`
    );
  }
  return null;
}
