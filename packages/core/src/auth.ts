import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * 密码哈希与会话令牌。
 *
 * 用 Node 内置 `crypto.scrypt`，不引入 argon2/bcrypt 原生依赖——本项目的原生模块
 * （better-sqlite3）已经需要在目标平台编译，再加一个只会放大部署摩擦。
 *
 * scrypt 参数取 N=16384, r=8, p=1（约 16 MiB 内存/次），在服务端登录路径上足够，
 * 也不会让低配 VPS 在并发登录时被打爆。参数写进哈希串，将来调参不会让旧哈希失效。
 */

const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const KEY_LENGTH = 32;
const SALT_BYTES = 16;

export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

/** 格式：scrypt$N$r$p$saltBase64$hashBase64。参数随哈希走，便于平滑升级。 */
export function hashPassword(password: string): string {
  const salt = randomBytes(SALT_BYTES);
  const derived = scryptSync(password, salt, KEY_LENGTH, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ["scrypt", SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString("base64"), derived.toString("base64")].join("$");
}

/**
 * 校验密码。任何解析失败都返回 false 而不是抛错——
 * 坏掉的哈希行不该让登录接口 500，那会把"这个账号数据异常"暴露给攻击者。
 */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, rawN, rawR, rawP, saltB64, hashB64] = parts;
  const N = Number(rawN);
  const r = Number(rawR);
  const p = Number(rawP);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p) || N <= 0 || r <= 0 || p <= 0) return false;

  let expected: Buffer;
  try {
    expected = Buffer.from(hashB64, "base64");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  let actual: Buffer;
  try {
    actual = scryptSync(password, Buffer.from(saltB64, "base64"), expected.length, { N, r, p });
  } catch {
    return false;
  }
  // 长度不等时 timingSafeEqual 会抛错，必须先比长度。
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(actual, expected);
}

/** 密码强度：只卡长度。复杂度规则会诱导用户用 "Passw0rd!" 这类可预测变体，收益为负。 */
export function isAcceptablePassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

/**
 * 会话令牌。明文只在 Cookie 里出现一次，库里只存 sha256。
 * 这样即使数据库泄露，攻击者也无法直接复用会话。
 */
export function issueSessionToken(): { token: string; tokenHash: string } {
  const token = randomBytes(32).toString("base64url");
  return { token, tokenHash: hashToken(token) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export const SESSION_COOKIE_NAME = "ecomgen_session";
export const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
export const PASSWORD_RESET_TTL_SECONDS = 60 * 60;
