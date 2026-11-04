import { useMemo, useState } from "react";
import { Alert, App as AntdApp, Button, Card, InputNumber, Space, Table, Tag, Typography } from "antd";
import { ArrowLeft, CreditCard, RefreshCw } from "lucide-react";
import { Link } from "react-router";

import { useBillingOrders, useCreateTopup } from "../../api/hooks/useBilling";
import { ORDER_STATUS_LABEL, formatYuan, type PaymentOrder, type PaymentOrderStatus } from "../../api/billingClient";
import { useSession } from "../../api/hooks/useSession";
import { formatCredits } from "../../api/session";
import { UserMenu } from "../../components/UserMenu";
import styles from "./billing.module.css";

/**
 * 充值页。
 *
 * 两件刻意的取舍：
 * 1. **不自动跳转收银台**。异步请求之后的重定向容易被浏览器拦截，
 *    而且用户看不到"要付多少钱"就跳走了。这里先展示金额与「去支付」按钮，由用户点击。
 * 2. **价格只从接口取**（`pricePerCreditCents`）。前端不写死单价，
 *    否则管理员改价后用户会看到两个不同的数字。
 */

const PRESETS = [10, 50, 100, 500];

const STATUS_COLOR: Record<PaymentOrderStatus, string> = {
  created: "gold",
  pending: "gold",
  paid: "green",
  closed: "default",
  failed: "red",
};

export function BillingPage() {
  const { message } = AntdApp.useApp();
  const session = useSession();
  const orders = useBillingOrders();
  const createTopup = useCreateTopup();

  const [credits, setCredits] = useState<number>(50);
  const [checkoutUrl, setCheckoutUrl] = useState<string | null>(null);

  const pricePerCreditCents = orders.data?.pricePerCreditCents ?? 100;
  const amountCents = useMemo(() => Math.round(Math.max(credits || 0, 0) * pricePerCreditCents), [credits, pricePerCreditCents]);

  const submit = async () => {
    if (!credits || credits <= 0) {
      message.warning("请填写要充值的积分数量");
      return;
    }
    try {
      const result = await createTopup.mutateAsync(credits);
      setCheckoutUrl(result.checkoutUrl);
      message.success("订单已创建，请点击「去支付」完成付款");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "下单失败");
    }
  };

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Space size={12}>
          <Link to="/" className={styles.back}>
            <ArrowLeft size={16} strokeWidth={1.75} />
            返回工作台
          </Link>
          <Typography.Title level={4} className={styles.title}>
            充值
          </Typography.Title>
        </Space>
        <UserMenu />
      </header>

      <main className={styles.body}>
        <Card className={styles.panel} title="购买积分">
          <Typography.Paragraph type="secondary" className={styles.hint}>
            当前余额 {formatCredits(session.data?.balanceMicrocredits)} 积分 · 单价 {formatYuan(pricePerCreditCents)} 元 / 积分
          </Typography.Paragraph>

          <Space wrap className={styles.presets}>
            {PRESETS.map((preset) => (
              <Button key={preset} type={credits === preset ? "primary" : "default"} onClick={() => setCredits(preset)}>
                {preset} 积分
              </Button>
            ))}
          </Space>

          <Space className={styles.amountRow} align="center">
            <span>自定义数量</span>
            <InputNumber min={1} precision={0} value={credits} onChange={(value) => setCredits(Number(value ?? 0))} style={{ width: 160 }} addonAfter="积分" />
            <Typography.Text strong className={styles.total}>
              应付 {formatYuan(amountCents)} 元
            </Typography.Text>
          </Space>

          {checkoutUrl ? (
            <Alert
              className={styles.checkout}
              type="info"
              showIcon
              message="订单已创建，等待付款"
              description={
                <Space direction="vertical" size={8}>
                  <span>请在 30 分钟内完成支付，超时订单会自动关闭。</span>
                  <Button type="primary" href={checkoutUrl} target="_self" icon={<CreditCard size={14} />}>
                    去支付
                  </Button>
                </Space>
              }
            />
          ) : (
            <Button type="primary" size="large" loading={createTopup.isPending} onClick={() => void submit()} icon={<CreditCard size={16} />}>
              去支付 {formatYuan(amountCents)} 元
            </Button>
          )}
        </Card>

        <Card
          className={styles.panel}
          title="充值记录"
          extra={
            <Button size="small" icon={<RefreshCw size={14} />} onClick={() => void orders.refetch()}>
              刷新
            </Button>
          }
        >
          <Table<PaymentOrder>
            rowKey="id"
            size="small"
            loading={orders.isPending}
            dataSource={orders.data?.items ?? []}
            pagination={false}
            columns={[
              { title: "创建时间", dataIndex: "createdAt", width: 200, render: (value: string) => new Date(value).toLocaleString("zh-CN") },
              { title: "积分", dataIndex: "credits", width: 100 },
              { title: "金额（元）", width: 120, render: (_, order) => formatYuan(order.amountCents) },
              {
                title: "状态",
                dataIndex: "status",
                width: 100,
                render: (value: PaymentOrderStatus) => <Tag color={STATUS_COLOR[value]}>{ORDER_STATUS_LABEL[value]}</Tag>,
              },
              {
                title: "操作",
                width: 120,
                render: (_, order) =>
                  order.status === "pending" || order.status === "created" ? (
                    <Link to={`/billing/return?orderId=${order.id}`}>查看进度</Link>
                  ) : null,
              },
            ]}
          />
        </Card>
      </main>
    </div>
  );
}
