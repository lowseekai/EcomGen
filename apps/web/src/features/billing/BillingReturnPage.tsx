import { Button, Result, Spin, Typography } from "antd";
import { Link, useSearchParams } from "react-router";

import { usePaymentOrder } from "../../api/hooks/useBilling";
import { formatYuan } from "../../api/billingClient";
import styles from "./billing.module.css";

/**
 * 支付回跳页。
 *
 * 网关是异步回调，用户跳回来时订单多半还是 pending，所以这里轮询而不是给一个
 * 一次性结论——否则用户看到"未支付"会以为钱丢了。
 */
export function BillingReturnPage() {
  const [params] = useSearchParams();
  const orderId = params.get("orderId");
  const order = usePaymentOrder(orderId);

  if (!orderId) {
    return (
      <div className={styles.centered}>
        <Result status="warning" title="缺少订单号" subTitle="支付回跳地址不完整，请回到充值页查看订单记录。" extra={<Link to="/billing">返回充值</Link>} />
      </div>
    );
  }

  if (order.isPending) {
    return (
      <div className={styles.centered}>
        <Spin tip="正在确认支付结果…" />
      </div>
    );
  }

  if (order.isError) {
    return (
      <div className={styles.centered}>
        <Result status="error" title="查询订单失败" subTitle={order.error instanceof Error ? order.error.message : "请稍后重试"} extra={<Link to="/billing">返回充值</Link>} />
      </div>
    );
  }

  const data = order.data!;
  if (data.status === "paid") {
    return (
      <div className={styles.centered}>
        <Result
          status="success"
          title="支付成功"
          subTitle={`已到账 ${data.credits} 积分（${formatYuan(data.amountCents)} 元）`}
          extra={<Link to="/">返回工作台</Link>}
        />
      </div>
    );
  }

  if (data.status === "failed" || data.status === "closed") {
    return (
      <div className={styles.centered}>
        <Result
          status="error"
          title={data.status === "closed" ? "订单已关闭" : "支付失败"}
          subTitle="未产生扣款。如已付款请联系管理员核对。"
          extra={<Link to="/billing">重新充值</Link>}
        />
      </div>
    );
  }

  // pending：继续轮询，同时给一个明确的"别关页面"提示。
  return (
    <div className={styles.centered}>
      <Result
        status="info"
        icon={<Spin />}
        title="正在等待支付结果"
        subTitle={
          <Typography.Text type="secondary">
            订单 {data.credits} 积分 / {formatYuan(data.amountCents)} 元。支付完成后本页会自动更新，请勿关闭。
          </Typography.Text>
        }
        extra={
          <Button type="link">
            <Link to="/billing">返回充值页</Link>
          </Button>
        }
      />
    </div>
  );
}
