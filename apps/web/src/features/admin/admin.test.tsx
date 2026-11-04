import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { BASE } from "../../test/msw/handlers";
import { server } from "../../test/msw/server";
import { renderWithProviders } from "../../test/render";
import { AdminPage } from "./AdminPage";

/**
 * 管理后台的准入与首屏。
 *
 * 只测两件最容易坏的事：非管理员必须看到 403 而不是空白页；
 * 管理员的用户列表要真的把接口数据显示出来（而不是渲染了一个空表还显示"成功"）。
 */

const MEMBER = {
  id: "u-member",
  email: "member@example.com",
  displayName: "会员",
  role: "user" as const,
  status: "active" as const,
  emailVerifiedAt: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  balanceMicrocredits: 1_500_000,
};

function sessionAs(role: "owner" | "admin" | "support" | "user") {
  return http.get(`${BASE}/auth/me`, () =>
    HttpResponse.json({
      user: { id: "u-self", email: "self@example.com", displayName: "自己", role },
      balanceMicrocredits: 0,
    }),
  );
}

describe("管理后台", () => {
  it("普通用户看到 403，而不是空白页", async () => {
    server.use(sessionAs("user"));
    renderWithProviders(<AdminPage />);
    expect(await screen.findByText("没有权限", undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("管理员看到用户列表与余额", async () => {
    const user = userEvent.setup();
    server.use(
      sessionAs("owner"),
      http.get(`${BASE}/admin/dashboard`, () =>
        HttpResponse.json({
          users: { total: 1, active: 1, disabled: 0 },
          projects: { total: 0, active: 0 },
          jobs: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
          billing: { reserved: 0, uncertain: 0, settled: 0, refunded: 0, settledMicrocredits: 0 },
          credits: { issuedMicrocredits: 0, spentMicrocredits: 0, toppedUpMicrocredits: 0 },
          payments: { pending: 0, paid: 0, creditedMicrocredits: 0 },
          storage: { patterns: 0, models: 0, assets: 0, outputs: 0 },
          display: { settledCredits: 0, toppedUpCredits: 0, spentCredits: 0, issuedCredits: 0 },
        }),
      ),
      http.get(`${BASE}/admin/users`, () => HttpResponse.json({ items: [MEMBER], total: 1, limit: 100, offset: 0 })),
      http.get(`${BASE}/admin/audit`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
      http.get(`${BASE}/admin/prices`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/admin/billing/uncertain`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
    );

    renderWithProviders(<AdminPage />);
    // 默认页签是「概览」，用户列表要切过去才会挂载。
    await user.click(await screen.findByRole("tab", { name: "用户" }, { timeout: 5000 }));

    // 并行跑整个 web 套件时，首屏要等 session + 用户列表两个请求串行完成，
    // 默认 1s 的 findBy 超时在慢机上会偶发失败；这里给足余量。
    expect(await screen.findByText("member@example.com", undefined, { timeout: 5000 })).toBeInTheDocument();
    // 余额按积分展示（1_500_000 微积分 = 1.50 积分）。
    expect(await screen.findByText("1.50", undefined, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe("新建用户", () => {
  it("创建后一次性密码只展示一次，并可复制", async () => {
    const user = userEvent.setup();
    let submitted: unknown = null;

    server.use(
      sessionAs("owner"),
      http.get(`${BASE}/admin/dashboard`, () =>
        HttpResponse.json({
          users: { total: 1, active: 1, disabled: 0 },
          projects: { total: 0, active: 0 },
          jobs: { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 },
          billing: { reserved: 0, uncertain: 0, settled: 0, refunded: 0, settledMicrocredits: 0 },
          credits: { issuedMicrocredits: 0, spentMicrocredits: 0, toppedUpMicrocredits: 0 },
          payments: { pending: 0, paid: 0, creditedMicrocredits: 0 },
          storage: { patterns: 0, models: 0, assets: 0, outputs: 0 },
          display: { settledCredits: 0, toppedUpCredits: 0, spentCredits: 0, issuedCredits: 0 },
        }),
      ),
      http.get(`${BASE}/admin/users`, () => HttpResponse.json({ items: [], total: 0, limit: 100, offset: 0 })),
      http.get(`${BASE}/admin/audit`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
      http.get(`${BASE}/admin/prices`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/admin/billing/uncertain`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
      http.post(`${BASE}/admin/users`, async ({ request }) => {
        submitted = await request.json();
        return HttpResponse.json({ ...MEMBER, id: "u-new", email: "new@example.com", generatedPassword: "gen-pass-abcdef" }, { status: 201 });
      }),
    );

    renderWithProviders(<AdminPage />);
    // 默认页签是「概览」，用户列表要切过去才会挂载。
    await user.click(await screen.findByRole("tab", { name: "用户" }, { timeout: 5000 }));
    await user.click(await screen.findByRole("button", { name: /新建用户/ }, { timeout: 5000 }));

    await user.type(await screen.findByLabelText("邮箱"), "new@example.com");
    await user.click(screen.getByRole("button", { name: "创建" }));

    // 生成的一次性密码必须出现在结果弹窗里——它不会再有第二次展示机会。
    expect(await screen.findByText("gen-pass-abcdef", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(submitted).toMatchObject({ email: "new@example.com", role: "user" });
  });
});

describe("支付配置", () => {
  const EMPTY_HANDLERS = [
    http.get(`${BASE}/admin/users`, () => HttpResponse.json({ items: [], total: 0, limit: 100, offset: 0 })),
    http.get(`${BASE}/admin/audit`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
    http.get(`${BASE}/admin/prices`, () => HttpResponse.json({ items: [] })),
    http.get(`${BASE}/admin/billing/uncertain`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
  ];

  it("未配置渠道时给出明确警告", async () => {
    const user = userEvent.setup();
    server.use(
      sessionAs("owner"),
      ...EMPTY_HANDLERS,
      http.get(`${BASE}/admin/payments/config`, () =>
        HttpResponse.json({ provider: null, hasKey: false, gateway: null, pid: null, payType: "alipay", pricePerCreditCents: 100, publicBaseUrl: "" }),
      ),
    );

    renderWithProviders(<AdminPage />);
    await user.click(await screen.findByRole("tab", { name: "支付配置" }, { timeout: 5000 }));
    expect(await screen.findByText("尚未配置支付渠道", undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("密钥留空时提交体里没有 key，避免把已配置的密钥清空", async () => {
    const user = userEvent.setup();
    let patched: Record<string, unknown> | null = null;

    server.use(
      sessionAs("owner"),
      ...EMPTY_HANDLERS,
      http.get(`${BASE}/admin/payments/config`, () =>
        HttpResponse.json({ provider: "epay", hasKey: true, gateway: "https://pay.example.com/", pid: "1001", payType: "alipay", pricePerCreditCents: 250, publicBaseUrl: "" }),
      ),
      http.patch(`${BASE}/admin/payments/config`, async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, hasKey: true });
      }),
    );

    renderWithProviders(<AdminPage />);
    await user.click(await screen.findByRole("tab", { name: "支付配置" }, { timeout: 5000 }));
    await user.click(await screen.findByRole("button", { name: "保存配置" }, { timeout: 5000 }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).not.toHaveProperty("key");
    expect(patched!.gateway).toBe("https://pay.example.com/");
    // 单价跟着表单一起提交，改价不需要再去改数据库。
    expect(patched!.pricePerCreditCents).toBe(250);
  });

  it("只读角色看到禁用的表单", async () => {
    const user = userEvent.setup();
    server.use(
      sessionAs("support"),
      ...EMPTY_HANDLERS,
      http.get(`${BASE}/admin/payments/config`, () =>
        HttpResponse.json({ provider: "epay", hasKey: true, gateway: "https://pay.example.com/", pid: "1001", payType: "alipay", pricePerCreditCents: 100, publicBaseUrl: "" }),
      ),
    );

    renderWithProviders(<AdminPage />);
    await user.click(await screen.findByRole("tab", { name: "支付配置" }, { timeout: 5000 }));
    expect(await screen.findByRole("button", { name: "保存配置" }, { timeout: 5000 })).toBeDisabled();
  });
});

describe("邮件配置", () => {
  const EMPTY_HANDLERS = [
    http.get(`${BASE}/admin/users`, () => HttpResponse.json({ items: [], total: 0, limit: 100, offset: 0 })),
    http.get(`${BASE}/admin/audit`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
    http.get(`${BASE}/admin/prices`, () => HttpResponse.json({ items: [] })),
    http.get(`${BASE}/admin/billing/uncertain`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
    http.get(`${BASE}/admin/payments/config`, () =>
      HttpResponse.json({ provider: null, hasKey: false, gateway: null, pid: null, payType: "alipay", pricePerCreditCents: 100, publicBaseUrl: "" }),
    ),
  ];

  const UNCONFIGURED = {
    configured: false,
    host: null,
    port: 587,
    secure: false,
    requireStartTls: true,
    user: null,
    from: null,
    fromName: null,
    hasPass: false,
  };

  const CONFIGURED = {
    configured: true,
    host: "smtp.example.com",
    port: 465,
    secure: true,
    requireStartTls: true,
    user: "mailer",
    from: "no-reply@example.com",
    fromName: "EcomGen",
    hasPass: true,
  };

  it("未配置时给出警告，且测试连接不可点", async () => {
    const user = userEvent.setup();
    server.use(sessionAs("owner"), ...EMPTY_HANDLERS, http.get(`${BASE}/admin/settings/mail`, () => HttpResponse.json(UNCONFIGURED)));

    renderWithProviders(<AdminPage />);
    await user.click(await screen.findByRole("tab", { name: "邮件" }, { timeout: 5000 }));

    expect(await screen.findByText("尚未配置邮件服务器", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "测试连接" })).toBeDisabled();
  });

  it("口令留空时提交体里没有 pass，避免把已配置的服务器清坏", async () => {
    const user = userEvent.setup();
    let patched: Record<string, unknown> | null = null;

    server.use(
      sessionAs("owner"),
      ...EMPTY_HANDLERS,
      http.get(`${BASE}/admin/settings/mail`, () => HttpResponse.json(CONFIGURED)),
      http.patch(`${BASE}/admin/settings/mail`, async ({ request }) => {
        patched = (await request.json()) as Record<string, unknown>;
        return HttpResponse.json({ ok: true, hasPass: true });
      }),
    );

    renderWithProviders(<AdminPage />);
    await user.click(await screen.findByRole("tab", { name: "邮件" }, { timeout: 5000 }));
    await user.click(await screen.findByRole("button", { name: "保存配置" }, { timeout: 5000 }));

    await waitFor(() => expect(patched).not.toBeNull());
    expect(patched).not.toHaveProperty("pass");
    expect(patched!.host).toBe("smtp.example.com");
    expect(patched!.port).toBe(465);
  });

  it("测试连接成功后给出提示", async () => {
    const user = userEvent.setup();
    server.use(
      sessionAs("owner"),
      ...EMPTY_HANDLERS,
      http.get(`${BASE}/admin/settings/mail`, () => HttpResponse.json(CONFIGURED)),
      http.post(`${BASE}/admin/settings/mail/test`, () => HttpResponse.json({ ok: true })),
    );

    renderWithProviders(<AdminPage />);
    await user.click(await screen.findByRole("tab", { name: "邮件" }, { timeout: 5000 }));
    await user.click(await screen.findByRole("button", { name: "测试连接" }, { timeout: 5000 }));

    expect(await screen.findByText("连接与认证通过", undefined, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe("待裁决计费单提示", () => {
  const BASE_HANDLERS = [
    http.get(`${BASE}/admin/users`, () => HttpResponse.json({ items: [], total: 0, limit: 100, offset: 0 })),
    http.get(`${BASE}/admin/audit`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
    http.get(`${BASE}/admin/prices`, () => HttpResponse.json({ items: [] })),
    http.get(`${BASE}/admin/payments/config`, () =>
      HttpResponse.json({ provider: null, hasKey: false, gateway: null, pid: null, payType: "alipay", pricePerCreditCents: 100, publicBaseUrl: "" }),
    ),
    http.get(`${BASE}/admin/settings/mail`, () =>
      HttpResponse.json({ configured: false, host: null, port: 587, secure: false, requireStartTls: true, user: null, from: null, fromName: null, hasPass: false }),
    ),
  ];

  it("有待裁决订单时页签上带数量", async () => {
    server.use(
      sessionAs("owner"),
      ...BASE_HANDLERS,
      http.get(`${BASE}/admin/billing/uncertain`, () =>
        HttpResponse.json({
          items: [
            { id: "order-1", userId: "u1", jobId: "j1", status: "uncertain", reservedMicrocredits: 1_000_000, settledMicrocredits: null, costSnapshot: {}, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", user: null },
          ],
          limit: 100,
          offset: 0,
        }),
      ),
    );

    renderWithProviders(<AdminPage />);
    expect(await screen.findByRole("tab", { name: "待裁决计费单 (1)" }, { timeout: 5000 })).toBeInTheDocument();
  });

  it("没有待裁决订单时页签不带数字", async () => {
    server.use(sessionAs("owner"), ...BASE_HANDLERS, http.get(`${BASE}/admin/billing/uncertain`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })));

    renderWithProviders(<AdminPage />);
    expect(await screen.findByRole("tab", { name: "待裁决计费单" }, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe("概览", () => {
  it("默认展示概览，并渲染各维度统计", async () => {
    server.use(
      sessionAs("owner"),
      http.get(`${BASE}/admin/dashboard`, () =>
        HttpResponse.json({
          users: { total: 7, active: 6, disabled: 1 },
          projects: { total: 12, active: 9 },
          jobs: { total: 40, queued: 2, running: 1, succeeded: 35, failed: 2, cancelled: 0 },
          billing: { reserved: 1, uncertain: 3, settled: 20, refunded: 1, settledMicrocredits: 5_000_000 },
          credits: { issuedMicrocredits: 9_000_000, spentMicrocredits: 4_000_000, toppedUpMicrocredits: 2_000_000 },
          payments: { pending: 1, paid: 2, creditedMicrocredits: 1_000_000 },
          storage: { patterns: 4, models: 3, assets: 11, outputs: 22 },
          display: { settledCredits: 5, toppedUpCredits: 2, spentCredits: 4, issuedCredits: 9 },
        }),
      ),
      http.get(`${BASE}/admin/users`, () => HttpResponse.json({ items: [], total: 0, limit: 100, offset: 0 })),
      http.get(`${BASE}/admin/audit`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
      http.get(`${BASE}/admin/prices`, () => HttpResponse.json({ items: [] })),
      http.get(`${BASE}/admin/billing/uncertain`, () => HttpResponse.json({ items: [], limit: 100, offset: 0 })),
      http.get(`${BASE}/admin/payments/config`, () =>
        HttpResponse.json({ provider: null, hasKey: false, gateway: null, pid: null, payType: "alipay", pricePerCreditCents: 100, publicBaseUrl: "" }),
      ),
      http.get(`${BASE}/admin/settings/mail`, () =>
        HttpResponse.json({ configured: false, host: null, port: 587, secure: false, requireStartTls: true, user: null, from: null, fromName: null, hasPass: false }),
      ),
    );

    renderWithProviders(<AdminPage />);

    // 默认页签就是概览：不需要点任何标签就能看到统计。
    expect(await screen.findByText("用户总数", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText("待裁决", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText("生成图", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText("12", undefined, { timeout: 5000 })).toBeInTheDocument();
  });
});
