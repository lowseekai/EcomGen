import { connect as netConnect, type Socket } from "node:net";
import { connect as tlsConnect, type TLSSocket } from "node:tls";
import { randomUUID } from "node:crypto";

/**
 * 最小 SMTP 客户端。
 *
 * 为什么自己写而不是引入 nodemailer：这个仓库已经自建了 cookie 解析、限流与 scrypt，
 * 邮件这一层需要的也只是「EHLO → STARTTLS → AUTH → MAIL/RCPT/DATA」这一条直线，
 * 引入一个带完整 MIME 构建器的依赖反而增加升级面。代价是这里只支持纯文本/HTML 两种正文，
 * 不支持附件与多收件人——够用就好，缺了再加。
 *
 * 安全默认：587/25 一律尝试 STARTTLS，服务端不提供则失败而不是明文发信。
 * 明文投递会把密码重置链接暴露在链路上。
 */

export interface SmtpConfig {
  host: string;
  port: number;
  /** true = 隐式 TLS（通常 465）；false = 明文连接后 STARTTLS 升级（通常 587/25）。 */
  secure: boolean;
  user: string;
  pass: string;
  from: string;
  fromName?: string;
  /**
   * 是否强制 STARTTLS。默认 true。
   *
   * 只有受信任的内网中继才该设成 false：明文投递会把密码重置链接暴露在链路上。
   * 保留这个开关是因为自建中继（如本地 postfix）常常不提供 TLS。
   */
  requireStartTls?: boolean;
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export class SmtpError extends Error {
  public constructor(message: string, public readonly code: number | null = null) {
    super(message);
    this.name = "SmtpError";
  }
}

interface SmtpResponse {
  code: number;
  lines: string[];
}

const CRLF = "\r\n";

/** 行缓冲读取器：SMTP 是行协议，但 TCP 分片不按行到达。 */
class LineReader {
  private buffer = "";
  private pending: Array<{ resolve: (line: string) => void; reject: (error: Error) => void }> = [];
  private failure: Error | null = null;
  private ended = false;

  public constructor(private readonly socket: Socket | TLSSocket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.drain();
    });
    socket.on("error", (error) => this.fail(error));
    socket.on("close", () => this.fail(new SmtpError("SMTP 连接被关闭")));
    socket.on("timeout", () => this.fail(new SmtpError("SMTP 连接超时")));
  }

  public readLine(): Promise<string> {
    if (this.failure) return Promise.reject(this.failure);
    const index = this.buffer.indexOf("\n");
    if (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      return Promise.resolve(line);
    }
    if (this.ended) return Promise.reject(new SmtpError("SMTP 连接已结束"));
    return new Promise<string>((resolve, reject) => this.pending.push({ resolve, reject }));
  }

  private drain(): void {
    while (this.pending.length > 0) {
      const index = this.buffer.indexOf("\n");
      if (index < 0) return;
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.pending.shift()!.resolve(line);
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const waiter of this.pending.splice(0)) waiter.reject(error);
  }
}

/** 读一个完整响应：`250-` 是续行，`250 ` 才是结束。 */
async function readResponse(reader: LineReader): Promise<SmtpResponse> {
  const lines: string[] = [];
  for (;;) {
    const line = await reader.readLine();
    lines.push(line);
    if (/^\d{3} /.test(line)) return { code: Number(line.slice(0, 3)), lines };
  }
}

async function command(reader: LineReader, socket: Socket | TLSSocket, text: string, expect: number[]): Promise<SmtpResponse> {
  socket.write(text + CRLF);
  const response = await readResponse(reader);
  if (!expect.includes(response.code)) {
    // 认证失败时不能把服务器原文回给前端（可能含账号提示），只带状态码。
    throw new SmtpError(`SMTP 命令被拒绝：${text.split(" ")[0]} → ${response.code}`, response.code);
  }
  return response;
}

function connectSocket(config: SmtpConfig, timeoutMs: number): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => reject(new SmtpError(`无法连接 SMTP 服务器：${error.message}`));
    const socket = config.secure
      ? tlsConnect({ host: config.host, port: config.port, servername: config.host }, () => resolve(socket))
      : netConnect({ host: config.host, port: config.port }, () => resolve(socket));
    socket.setTimeout(timeoutMs);
    socket.once("error", onError);
  });
}

function upgradeToTls(socket: Socket, host: string): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const secure = tlsConnect({ socket, servername: host }, () => resolve(secure));
    secure.once("error", (error) => reject(new SmtpError(`STARTTLS 升级失败：${error.message}`)));
  });
}

function encodeHeaderValue(value: string): string {
  // 非 ASCII 走 RFC 2047 encoded-word；纯 ASCII 原样，避免无谓的编码损失可读性。
  return /^[\x20-\x7E]*$/.test(value) ? value : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64Lines(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/(.{76})/g, `$1${CRLF}`);
}

function buildData(config: SmtpConfig, message: MailMessage): string {
  const from = config.fromName ? `${encodeHeaderValue(config.fromName)} <${config.from}>` : config.from;
  const headers = [
    `From: ${from}`,
    `To: ${message.to}`,
    `Subject: ${encodeHeaderValue(message.subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomUUID()}@${config.from.split("@")[1] ?? "localhost"}>`,
    "MIME-Version: 1.0",
  ];

  if (message.html) {
    const boundary = `----ecomgen-${randomUUID()}`;
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    const body = [
      `--${boundary}`,
      "Content-Type: text/plain; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(message.text),
      `--${boundary}`,
      "Content-Type: text/html; charset=UTF-8",
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(message.html),
      `--${boundary}--`,
    ].join(CRLF);
    return `${headers.join(CRLF)}${CRLF}${CRLF}${body}`;
  }

  headers.push("Content-Type: text/plain; charset=UTF-8", "Content-Transfer-Encoding: base64");
  return `${headers.join(CRLF)}${CRLF}${CRLF}${base64Lines(message.text)}`;
}

/** DATA 阶段的点填充：以 `.` 开头的行要再加一个 `.`，否则会被当成结束符。 */
function dotStuff(payload: string): string {
  return payload
    .split(CRLF)
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join(CRLF);
}

/**
 * 发送一封邮件。
 *
 * 失败一律抛 `SmtpError`，由调用方决定是「记日志后忽略」（用户侧找回密码不能因为
 * 邮件发不出去就报错，否则等于告诉攻击者"这个邮箱存在但发信失败"）还是「回给管理员」（测试发信）。
 */
export async function sendMail(config: SmtpConfig, message: MailMessage, options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 15_000;
  let socket: Socket | TLSSocket | null = null;
  try {
    socket = await connectSocket(config, timeoutMs);
    let reader = new LineReader(socket);

    const greeting = await readResponse(reader);
    if (greeting.code !== 220) throw new SmtpError(`SMTP 服务器拒绝连接：${greeting.code}`, greeting.code);

    const ehlo = await command(reader, socket, "EHLO ecomgen", [250]);

    if (!config.secure) {
      const supportsStartTls = ehlo.lines.some((line) => /STARTTLS/i.test(line));
      if (supportsStartTls) {
        await command(reader, socket, "STARTTLS", [220]);
        const upgraded = await upgradeToTls(socket, config.host);
        socket = upgraded;
        reader = new LineReader(upgraded);
        await command(reader, socket, "EHLO ecomgen", [250]);
      } else if (config.requireStartTls !== false) {
        // 明文投递会把重置链接暴露在链路上，默认宁可失败。
        throw new SmtpError("SMTP 服务器未提供 STARTTLS，已拒绝明文投递");
      }
    }

    // AUTH PLAIN 一行完成；部分服务器只支持 LOGIN，按 5xx 回退。
    const credentials = Buffer.from(`\0${config.user}\0${config.pass}`, "utf8").toString("base64");
    try {
      await command(reader, socket, `AUTH PLAIN ${credentials}`, [235]);
    } catch (error) {
      if (!(error instanceof SmtpError) || error.code === null || error.code < 500) throw error;
      await command(reader, socket, "AUTH LOGIN", [334]);
      await command(reader, socket, Buffer.from(config.user, "utf8").toString("base64"), [334]);
      await command(reader, socket, Buffer.from(config.pass, "utf8").toString("base64"), [235]);
    }

    await command(reader, socket, `MAIL FROM:<${config.from}>`, [250]);
    await command(reader, socket, `RCPT TO:<${message.to}>`, [250, 251]);
    await command(reader, socket, "DATA", [354]);

    const payload = dotStuff(buildData(config, message));
    socket.write(payload + CRLF + "." + CRLF);
    const accepted = await readResponse(reader);
    if (accepted.code !== 250) throw new SmtpError(`邮件被拒绝：${accepted.code}`, accepted.code);

    socket.write(`QUIT${CRLF}`);
    return;
  } finally {
    socket?.end();
    socket?.destroy();
  }
}

/** 站点设置里保存 SMTP 配置的键；密钥随配置一起存，永不回显。 */
export const MAIL_SETTINGS_KEY = "mail.smtp";

export function readSmtpConfig(repository: { getSetting<T>(key: string, fallback: T): T }): SmtpConfig | null {
  const raw = repository.getSetting<Partial<SmtpConfig> | null>(MAIL_SETTINGS_KEY, null);
  if (!raw || !raw.host || !raw.from) return null;
  return {
    host: raw.host,
    port: Number(raw.port ?? 587),
    secure: Boolean(raw.secure),
    user: raw.user ?? "",
    pass: raw.pass ?? "",
    from: raw.from,
    fromName: raw.fromName,
  };
}

/**
 * 只做连通性与认证检查，不发信。
 *
 * 管理端的"测试连接"用它：管理员要确认的是"配置对不对"，
 * 而不是给自己塞一封垃圾邮件。
 */
export async function verifySmtp(config: SmtpConfig, options: { timeoutMs?: number } = {}): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  let socket: Socket | TLSSocket | null = null;
  try {
    socket = await connectSocket(config, timeoutMs);
    let reader = new LineReader(socket);
    const greeting = await readResponse(reader);
    if (greeting.code !== 220) throw new SmtpError(`SMTP 服务器拒绝连接：${greeting.code}`, greeting.code);

    const ehlo = await command(reader, socket, "EHLO ecomgen", [250]);
    if (!config.secure) {
      if (ehlo.lines.some((line) => /STARTTLS/i.test(line))) {
        await command(reader, socket, "STARTTLS", [220]);
        const upgraded = await upgradeToTls(socket, config.host);
        socket = upgraded;
        reader = new LineReader(upgraded);
        await command(reader, socket, "EHLO ecomgen", [250]);
      } else if (config.requireStartTls !== false) {
        throw new SmtpError("SMTP 服务器未提供 STARTTLS");
      }
    }
    if (config.user) {
      const credentials = Buffer.from(`\0${config.user}\0${config.pass}`, "utf8").toString("base64");
      await command(reader, socket, `AUTH PLAIN ${credentials}`, [235]);
    }
    socket.write(`QUIT${CRLF}`);
  } finally {
    socket?.end();
    socket?.destroy();
  }
}

export interface PasswordResetMail {
  to: string;
  resetUrl: string;
  /** 有效期（分钟），用于正文提示。 */
  expiresInMinutes: number;
}

export function buildPasswordResetMessage(input: PasswordResetMail, fromName = "EcomGen"): MailMessage {
  const text = [
    `你正在重置 ${fromName} 的登录密码。`,
    "",
    `打开下面的链接设置新密码（${input.expiresInMinutes} 分钟内有效）：`,
    input.resetUrl,
    "",
    "如果这不是你本人的操作，请忽略这封邮件，你的密码不会被修改。",
  ].join("\n");

  const html = [
    `<p>你正在重置 <strong>${escapeHtml(fromName)}</strong> 的登录密码。</p>`,
    `<p>打开下面的链接设置新密码（${input.expiresInMinutes} 分钟内有效）：</p>`,
    `<p><a href="${escapeHtml(input.resetUrl)}">${escapeHtml(input.resetUrl)}</a></p>`,
    "<p>如果这不是你本人的操作，请忽略这封邮件，你的密码不会被修改。</p>",
  ].join("");

  return { to: input.to, subject: `重置 ${fromName} 登录密码`, text, html };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}
