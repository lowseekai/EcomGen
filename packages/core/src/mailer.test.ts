import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server, type Socket } from "node:net";

import {
  SmtpError,
  buildPasswordResetMessage,
  readSmtpConfig,
  sendMail,
  verifySmtp,
  type SmtpConfig,
} from "./mailer.js";

/**
 * SMTP 客户端。
 *
 * 用进程内的假 SMTP 服务器跑完整协议流程（EHLO → AUTH → MAIL/RCPT/DATA → QUIT），
 * 而不是只测拼字符串：真正的坑在"多行响应怎么收尾""AUTH 失败怎么回退""点填充漏了没"，
 * 这些只有把协议跑一遍才看得见。
 *
 * 假服务器不提供 TLS，因此配置里显式 `requireStartTls: false`——那条分支本身也有用例覆盖。
 */

type Handler = (socket: Socket, line: string) => void;

interface FakeServer {
  server: Server;
  port: number;
  /** 收到的完整 DATA 载荷（已去掉结束符）。 */
  received: string[];
  close: () => Promise<void>;
}

async function startFakeSmtp(options: { advertiseStartTls?: boolean; rejectAuthPlain?: boolean; rejectData?: boolean } = {}): Promise<FakeServer> {
  const received: string[] = [];
  const server = createServer((socket) => {
    // 客户端在 QUIT 后立刻断开，服务器侧会收到 ECONNRESET；不吞掉会变成未捕获异常。
    socket.on("error", () => { });
    socket.setEncoding("utf8");
    let buffer = "";
    let inData = false;
    let dataBuffer = "";
    // AUTH LOGIN 是三段式：命令 → 用户名 → 口令，必须按步回应，否则会把 base64 当成命令。
    let authLoginStep = 0;

    socket.write("220 fake.smtp ESMTP\r\n");

    const handle: Handler = (_socket, line) => {
      if (inData) {
        if (line === ".") {
          inData = false;
          if (options.rejectData) {
            socket.write("554 message rejected\r\n");
            return;
          }
          received.push(dataBuffer);
          dataBuffer = "";
          socket.write("250 2.0.0 Ok: queued\r\n");
          return;
        }
        // 客户端做过点填充，这里还原。
        dataBuffer += (line.startsWith("..") ? line.slice(1) : line) + "\r\n";
        return;
      }

      if (authLoginStep === 1) { authLoginStep = 2; socket.write("334 UGFzc3dvcmQ6\r\n"); return; }
      if (authLoginStep === 2) { authLoginStep = 0; socket.write("235 2.7.0 Authentication successful\r\n"); return; }

      const command = line.toUpperCase();
      if (command.startsWith("EHLO")) {
        const lines = ["250-fake.smtp", "250-8BITMIME"];
        if (options.advertiseStartTls) lines.push("250-STARTTLS");
        lines.push("250 AUTH PLAIN LOGIN");
        socket.write(lines.join("\r\n") + "\r\n");
        return;
      }
      if (command.startsWith("AUTH PLAIN")) {
        socket.write(options.rejectAuthPlain ? "504 5.5.4 unrecognized\r\n" : "235 2.7.0 Authentication successful\r\n");
        return;
      }
      if (command.startsWith("AUTH LOGIN")) {
        authLoginStep = 1;
        socket.write("334 VXNlcm5hbWU6\r\n");
        return;
      }
      if (command.startsWith("MAIL FROM")) {
        socket.write("250 2.1.0 Ok\r\n");
        return;
      }
      if (command.startsWith("RCPT TO")) {
        socket.write("250 2.1.5 Ok\r\n");
        return;
      }
      if (command === "DATA") {
        inData = true;
        socket.write("354 End data with <CR><LF>.<CR><LF>\r\n");
        return;
      }
      if (command === "QUIT") {
        socket.write("221 2.0.0 Bye\r\n");
        socket.end();
        return;
      }
      socket.write("500 5.5.1 unrecognized command\r\n");
    };

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let index = buffer.indexOf("\r\n");
      while (index >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        handle(socket, line);
        index = buffer.indexOf("\r\n");
      }
    });
  });

  server.on("error", () => { });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("fake smtp failed to bind");

  return {
    server,
    port: address.port,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function config(port: number, overrides: Partial<SmtpConfig> = {}): SmtpConfig {
  return {
    host: "127.0.0.1",
    port,
    secure: false,
    user: "mailer",
    pass: "secret",
    from: "no-reply@ecomgen.local",
    fromName: "EcomGen",
    requireStartTls: false,
    ...overrides,
  };
}

let fake: FakeServer | null = null;

afterEach(async () => {
  await fake?.close();
  fake = null;
});

describe("SMTP 投递", () => {
  it("完整走一遍 EHLO → AUTH → MAIL/RCPT/DATA → QUIT", async () => {
    fake = await startFakeSmtp();
    await sendMail(config(fake.port), { to: "user@example.com", subject: "你好", text: "正文一行" });

    expect(fake.received).toHaveLength(1);
    const payload = fake.received[0];
    expect(payload).toContain("To: user@example.com");
    // 中文标题走 RFC 2047 编码，正文走 base64——两者都不能是裸 8bit。
    expect(payload).toContain("Subject: =?UTF-8?B?");
    expect(payload).toContain("Content-Transfer-Encoding: base64");
  });

  it("正文里的点开头行被点填充，不会提前结束 DATA", async () => {
    fake = await startFakeSmtp();
    // 这行如果不做点填充，服务器会把它当成 DATA 结束符。
    await sendMail(config(fake.port), { to: "user@example.com", subject: "s", text: "normal\n.leading dot\nstill here" });

    expect(fake.received).toHaveLength(1);
    // 服务器还原了填充，所以收到的正文里是单点。
    const decoded = Buffer.from(fake.received[0].split("\r\n\r\n")[1] ?? "", "base64").toString("utf8");
    expect(decoded).toContain(".leading dot");
    expect(decoded).toContain("still here");
  });

  it("AUTH PLAIN 被拒时回退到 AUTH LOGIN", async () => {
    fake = await startFakeSmtp({ rejectAuthPlain: true });
    await expect(sendMail(config(fake.port), { to: "user@example.com", subject: "s", text: "t" })).resolves.toBeUndefined();
    expect(fake.received).toHaveLength(1);
  });

  it("服务器拒绝 DATA 时报错而不是静默成功", async () => {
    fake = await startFakeSmtp({ rejectData: true });
    await expect(sendMail(config(fake.port), { to: "user@example.com", subject: "s", text: "t" })).rejects.toBeInstanceOf(SmtpError);
  });

  it("未提供 STARTTLS 时默认拒绝明文投递", async () => {
    fake = await startFakeSmtp();
    // 默认 requireStartTls 为 true（这里显式去掉测试用的豁免）。
    await expect(
      sendMail(config(fake.port, { requireStartTls: undefined }), { to: "user@example.com", subject: "s", text: "t" }),
    ).rejects.toThrow(/STARTTLS/);
    expect(fake.received).toHaveLength(0);
  });

  it("连接失败给出明确错误", async () => {
    // 端口 1 上不会有服务。
    await expect(sendMail(config(1), { to: "user@example.com", subject: "s", text: "t" })).rejects.toBeInstanceOf(SmtpError);
  });
});

describe("连通性检查", () => {
  it("只认证不投递", async () => {
    fake = await startFakeSmtp();
    await expect(verifySmtp(config(fake.port))).resolves.toBeUndefined();
    expect(fake.received).toHaveLength(0);
  });
});

describe("配置读取", () => {
  it("缺 host 或 from 视为未配置", () => {
    const repository = { getSetting: <T,>(_key: string, fallback: T) => fallback };
    expect(readSmtpConfig(repository)).toBeNull();

    const configured = { getSetting: <T,>() => ({ host: "smtp.example.com", port: 465, secure: true, user: "u", pass: "p", from: "a@b.c" }) as T };
    expect(readSmtpConfig(configured)).toMatchObject({ host: "smtp.example.com", port: 465, secure: true });
  });
});

describe("密码重置邮件", () => {
  it("正文与 HTML 都带链接，且 HTML 做了转义", () => {
    const message = buildPasswordResetMessage({ to: "u@example.com", resetUrl: "https://app/reset?token=a&b=1", expiresInMinutes: 60 }, "Ecom<Gen>");
    expect(message.text).toContain("https://app/reset?token=a&b=1");
    expect(message.html).toContain("Ecom&lt;Gen&gt;");
    // 链接里的 & 必须转义，否则 HTML 解析会截断查询串。
    expect(message.html).toContain("token=a&amp;b=1");
    expect(message.subject).toContain("重置");
  });
});
