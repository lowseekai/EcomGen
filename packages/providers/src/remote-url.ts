import { ProviderError } from "./openai-compatible.js";

/**
 * 远程资源 URL 的安全校验（审计 P1-5）。
 *
 * Provider 会在响应里给出"结果图片的下载地址"，Worker 直接抓取。如果该地址指向
 * 内网或云元数据服务（169.254.169.254），Worker 就成了进入内网的跳板。
 *
 * 这里做第一层防护：只允许 http/https，并拒绝私有网段、回环、链路本地与常见内网域名。
 *
 * **已知残余风险**：本校验基于字面主机名，无法防御 DNS rebinding（域名先解析到公网、
 * 抓取时解析到内网）。彻底解决需要"解析后校验 IP 并按 IP 连接"，属于后续加固项。
 */

/** 允许自建 Provider 走内网地址（例如自托管的推理服务）。默认关闭。 */
function privateUrlsAllowed(): boolean {
  return (process.env.ECOMGEN_ALLOW_PRIVATE_PROVIDER_URLS ?? "").trim().toLowerCase() === "true";
}

const BLOCKED_HOSTNAMES = new Set(["localhost", "localhost.localdomain", "metadata", "metadata.google.internal", "instance-data"]);

/** 把 IPv4 字面量解析成四段数字；不是 IPv4 返回 null。 */
function parseIpv4(host: string): number[] | null {
  const parts = host.split(".");
  if (parts.length !== 4) return null;
  const octets = parts.map((part) => (/^\d{1,3}$/.test(part) ? Number(part) : Number.NaN));
  return octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255) ? null : octets;
}

function isPrivateIpv4(octets: number[]): boolean {
  const [a, b] = octets;
  if (a === 10) return true;                        // 10.0.0.0/8
  if (a === 127) return true;                       // 回环
  if (a === 0) return true;                         // 0.0.0.0/8
  if (a === 169 && b === 254) return true;          // 链路本地（含云元数据）
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 168) return true;          // 192.168.0.0/16
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
  return false;
}

function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (BLOCKED_HOSTNAMES.has(host)) return true;
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localhost")) return true;

  const ipv4 = parseIpv4(host);
  if (ipv4) return isPrivateIpv4(ipv4);

  // IPv6：回环、链路本地 fe80::/10、唯一本地 fc00::/7、IPv4 映射
  if (host === "::1" || host === "::") return true;
  if (/^fe[89ab][0-9a-f]:/.test(host)) return true;
  if (/^f[cd][0-9a-f]{2}:/.test(host)) return true;
  if (host.startsWith("::ffff:")) {
    const rest = host.slice("::ffff:".length);
    // WHATWG URL 会把 IPv4 映射地址归一化成十六进制（::ffff:7f00:1），
    // 所以两种写法都要能识别，否则 127.0.0.1 可以借这个形式绕过。
    const mapped = parseIpv4(rest);
    if (mapped) return isPrivateIpv4(mapped);
    const hex = /^([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(rest);
    if (hex) {
      const high = Number.parseInt(hex[1], 16);
      const low = Number.parseInt(hex[2], 16);
      return isPrivateIpv4([(high >> 8) & 0xff, high & 0xff, (low >> 8) & 0xff, low & 0xff]);
    }
  }
  return false;
}

/**
 * 校验并返回可安全抓取的 URL。不合法时抛 ProviderError（由任务级 catch 转为失败）。
 */
export function assertSafeRemoteUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ProviderError(`Provider returned an invalid resource URL: ${raw.slice(0, 120)}`, 502);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ProviderError(`Provider returned a non-HTTP resource URL (${url.protocol})`, 502);
  }
  if (!privateUrlsAllowed() && isPrivateHost(url.hostname)) {
    throw new ProviderError(`Provider returned a URL pointing at a private address: ${url.hostname}`, 502);
  }
  return url;
}
