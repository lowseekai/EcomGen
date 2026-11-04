import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import { BASE } from "../../test/msw/handlers";
import { server } from "../../test/msw/server";
import { renderWithProviders } from "../../test/render";
import { BillingPage } from "./BillingPage";
import { BillingReturnPage } from "./BillingReturnPage";

/**
 * 充值页与回跳页。
 *
 * 只测最容易错的三件事：价格口径（分 vs 元）、下单后是否真的给出收银台入口、
 * 回跳页对 pending / paid 的判断——最后一项错了用户会以为钱丢了。
 */

const ORDER = {
  id: "o-1",
  kind: "credits",
  credits: 50,
  amountCents: 5000,
  currency: "CNY",
  status: "pending" as const,
  provider: "epay",
  tradeNo: null,
  paidAt: null,
  creditedAt: null,
  expiresAt: "2026-01-01T00:30:00.000Z",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function sessionAs(balance = 0) {
  return http.get(`${BASE}/auth/me`, () =>
    HttpResponse.json({ user: { id: "u-1", email: "me@example.com", displayName: "我", role: "user" }, balanceMicrocredits: balance }),
  );
}

function ordersHandler(pricePerCreditCents = 100, items: unknown[] = []) {
  return http.get(`${BASE}/billing/orders`, () => HttpResponse.json({ items, pricePerCreditCents, limit: 50, offset: 0 }));
}

describe("充值页", () => {
  it("按接口下发的单价计算应付金额，切换档位即时更新", async () => {
    const user = userEvent.setup();
    server.use(sessionAs(0), ordersHandler(100));

    renderWithProviders(<BillingPage />);

    // 默认 50 积分 × 1.00 元 = 50.00 元
    expect(await screen.findByText("应付 50.00 元", undefined, { timeout: 5000 })).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "100 积分" }));
    expect(await screen.findByText("应付 100.00 元", undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("单价变化时应付金额随之变化（不写死在前端）", async () => {
    server.use(sessionAs(0), ordersHandler(250));
    renderWithProviders(<BillingPage />);
    // 50 × 2.50 = 125.00
    expect(await screen.findByText("应付 125.00 元", undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("下单成功后给出收银台入口，而不是自动跳转", async () => {
    const user = userEvent.setup();
    let posted: unknown = null;
    server.use(
      sessionAs(0),
      ordersHandler(100),
      http.post(`${BASE}/billing/topup-orders`, async ({ request }) => {
        posted = await request.json();
        return HttpResponse.json({ order: ORDER, checkoutUrl: "https://pay.example.com/checkout/abc" }, { status: 201 });
      }),
    );

    renderWithProviders(<BillingPage />);
    await user.click(await screen.findByRole("button", { name: /去支付 50\.00 元/ }, { timeout: 5000 }));

    expect(posted).toEqual({ credits: 50 });
    const link = await screen.findByRole("link", { name: /去支付/ }, { timeout: 5000 });
    expect(link).toHaveAttribute("href", "https://pay.example.com/checkout/abc");
  });

  it("订单列表渲染状态标签", async () => {
    server.use(sessionAs(0), ordersHandler(100, [ORDER, { ...ORDER, id: "o-2", status: "paid", credits: 10, amountCents: 1000 }]));
    renderWithProviders(<BillingPage />);
    expect(await screen.findByText("待支付", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText("已支付", undefined, { timeout: 5000 })).toBeInTheDocument();
  });
});

describe("支付回跳页", () => {
  it("已支付显示成功与到账积分", async () => {
    server.use(
      sessionAs(0),
      http.get(`${BASE}/billing/orders/o-1`, () => HttpResponse.json({ ...ORDER, status: "paid", paidAt: "2026-01-01T00:05:00.000Z", creditedAt: "2026-01-01T00:05:01.000Z" })),
    );
    renderWithProviders(<BillingReturnPage />, { initialEntries: ["/billing/return?orderId=o-1"] });

    expect(await screen.findByText("支付成功", undefined, { timeout: 5000 })).toBeInTheDocument();
    expect(await screen.findByText(/已到账 50 积分/, undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("未支付显示等待，而不是失败", async () => {
    server.use(sessionAs(0), http.get(`${BASE}/billing/orders/o-1`, () => HttpResponse.json(ORDER)));
    renderWithProviders(<BillingReturnPage />, { initialEntries: ["/billing/return?orderId=o-1"] });

    expect(await screen.findByText("正在等待支付结果", undefined, { timeout: 5000 })).toBeInTheDocument();
  });

  it("缺少订单号给出明确提示", async () => {
    server.use(sessionAs(0));
    renderWithProviders(<BillingReturnPage />, { initialEntries: ["/billing/return"] });
    expect(await screen.findByText("缺少订单号", undefined, { timeout: 5000 })).toBeInTheDocument();
  });
});
