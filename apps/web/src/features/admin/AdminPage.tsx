import { useState } from "react";
import {
  Alert,
  App as AntdApp,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Statistic,
  Switch,
  Spin,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import { ArrowLeft, Plus, RefreshCw } from "lucide-react";
import { Link } from "react-router";

import {
  useAdjustCredits,
  useAdminAudit,
  useAdminDashboard,
  useAdminLedger,
  useAdminPrices,
  useAdminUncertainOrders,
  useAdminUsers,
  useCreateAdminUser,
  useMailSettings,
  usePaymentConfig,
  useDeletePrice,
  usePatchAdminUser,
  useResetUserPassword,
  useResolveOrder,
  useTestMailSettings,
  useUpdateMailSettings,
  useUpdatePaymentConfig,
  useUpsertPrice,
} from "../../api/hooks/useAdmin";
import { useSession } from "../../api/hooks/useSession";
import { formatCredits, type AdminRole, type AdminUser, type PriceRecord } from "../../api/adminClient";
import { UserMenu } from "../../components/UserMenu";
import styles from "./admin.module.css";

/**
 * 管理后台。
 *
 * 四个面板对应四件只有管理员能做的事：管人、处理待裁决计费单、配价目、查审计。
 * 只读角色（support）能看但按钮禁用——后端也会拒，这里只是不让人白点。
 */
export function AdminPage() {
  const session = useSession();
  const role = session.data?.user?.role ?? "user";
  const canWrite = role === "owner" || role === "admin";
  // 待裁决计费单是"钱被占着等人处理"的异常，藏在页签里没人会点开。
  // 这里复用同一个 query key，与面板内的查询共享缓存，不会多发一次请求。
  const uncertainOrders = useAdminUncertainOrders();
  const uncertainCount = uncertainOrders.data?.items.length ?? 0;
  // 列表默认最多取 100 条，到顶时显示 99+ 而不是一个假的精确值。
  const uncertainLabel = uncertainCount === 0
    ? "待裁决计费单"
    : `待裁决计费单 (${uncertainCount >= 100 ? "99+" : uncertainCount})`;

  if (session.isPending) {
    return (
      <div className={styles.centered}>
        <Spin />
      </div>
    );
  }
  if (!canWrite && role !== "support") {
    return <Result status="403" title="没有权限" subTitle="管理后台仅对管理员与客服开放。" extra={<Link to="/">返回工作台</Link>} />;
  }

  return (
    <div className={styles.page}>
      <header className={styles.header}>
        <Space size={12}>
          <Link to="/" className={styles.back}>
            <ArrowLeft size={16} strokeWidth={1.75} />
            返回工作台
          </Link>
          <Typography.Title level={4} className={styles.title}>
            管理后台
          </Typography.Title>
        </Space>
        <UserMenu />
      </header>
      <main className={styles.body}>
        <Tabs
          items={[
            { key: "overview", label: "概览", children: <OverviewPanel /> },
            { key: "users", label: "用户", children: <UsersPanel canWrite={canWrite} /> },
            { key: "billing", label: uncertainLabel, children: <UncertainPanel canWrite={canWrite} /> },
            { key: "prices", label: "价目", children: <PricesPanel canWrite={canWrite} /> },
            { key: "payment", label: "支付配置", children: <PaymentPanel canWrite={canWrite} /> },
            { key: "mail", label: "邮件", children: <MailPanel canWrite={canWrite} /> },
            { key: "audit", label: "审计日志", children: <AuditPanel /> },
          ]}
        />
      </main>
    </div>
  );
}

// ---------------- 用户 ----------------

/**
 * 概览。
 *
 * 数据来自 `/admin/dashboard`——这个接口统计了用户、项目、任务、计费、额度、存储六个维度，
 * 之前前端从未调用过，等于白写。
 */
function OverviewPanel() {
  const dashboard = useAdminDashboard();

  if (dashboard.isPending) return <Spin />;
  if (dashboard.isError) return <Alert type="error" showIcon message="概览加载失败" description={dashboard.error instanceof Error ? dashboard.error.message : undefined} />;

  const data = dashboard.data;
  if (!data) return null;

  return (
    <div className={styles.panelBody}>
      <Typography.Title level={5}>用户与项目</Typography.Title>
      <div className={styles.statGrid}>
        <Statistic title="用户总数" value={data.users.total} />
        <Statistic title="活跃用户" value={data.users.active} />
        <Statistic title="已停用" value={data.users.disabled} />
        <Statistic title="项目总数" value={data.projects.total} />
        <Statistic title="进行中项目" value={data.projects.active} />
      </div>

      <Typography.Title level={5}>任务</Typography.Title>
      <div className={styles.statGrid}>
        <Statistic title="排队中" value={data.jobs.queued} />
        <Statistic title="运行中" value={data.jobs.running} />
        <Statistic title="成功" value={data.jobs.succeeded} />
        <Statistic title="失败" value={data.jobs.failed} />
        <Statistic title="已取消" value={data.jobs.cancelled} />
      </div>

      <Typography.Title level={5}>计费</Typography.Title>
      <div className={styles.statGrid}>
        <Statistic title="预扣中" value={data.billing.reserved} />
        <Statistic title="待裁决" value={data.billing.uncertain} valueStyle={data.billing.uncertain > 0 ? { color: "#cf1322" } : undefined} />
        <Statistic title="已结算单数" value={data.billing.settled} />
        <Statistic title="已退款单数" value={data.billing.refunded} />
        <Statistic title="已结算额度" value={formatCredits(data.billing.settledMicrocredits)} />
      </div>

      <Typography.Title level={5}>额度与收款</Typography.Title>
      <div className={styles.statGrid}>
        <Statistic title="累计发放" value={formatCredits(data.credits.issuedMicrocredits)} />
        <Statistic title="累计消耗" value={formatCredits(data.credits.spentMicrocredits)} />
        <Statistic title="累计充值" value={formatCredits(data.credits.toppedUpMicrocredits)} />
        <Statistic title="待支付订单" value={data.payments.pending} />
        <Statistic title="已支付订单" value={data.payments.paid} />
      </div>

      <Typography.Title level={5}>存储</Typography.Title>
      <div className={styles.statGrid}>
        <Statistic title="素材" value={data.storage.assets} />
        <Statistic title="生成图" value={data.storage.outputs} />
        <Statistic title="花型" value={data.storage.patterns} />
        <Statistic title="模特" value={data.storage.models} />
      </div>
    </div>
  );
}

function UsersPanel({ canWrite }: { canWrite: boolean }) {
  const { message } = AntdApp.useApp();
  const [keyword, setKeyword] = useState("");
  const [adjustTarget, setAdjustTarget] = useState<AdminUser | null>(null);
  const [ledgerTarget, setLedgerTarget] = useState<AdminUser | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

  const users = useAdminUsers({ keyword: keyword || undefined, limit: 100 });
  const patchUser = usePatchAdminUser();
  const resetPassword = useResetUserPassword();

  /** 邮件通道未接，忘记密码只能由管理员重置；重置会撤销该用户全部会话。 */
  const resetUserPassword = async (user: AdminUser) => {
    try {
      const result = await resetPassword.mutateAsync({ userId: user.id });
      if (result.generatedPassword) {
        Modal.success({
          title: `已重置 ${user.email} 的密码`,
          content: (
            <div>
              <p>该用户全部会话已失效。请把下面的新密码交给用户，关闭后无法再次查看：</p>
              <Typography.Text code copyable={{ text: result.generatedPassword }}>
                {result.generatedPassword}
              </Typography.Text>
            </div>
          ),
        });
      } else {
        message.success("密码已重置，该用户全部会话已失效");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "重置失败");
    }
  };

  const toggleStatus = async (user: AdminUser) => {
    const next = user.status === "active" ? "disabled" : "active";
    try {
      await patchUser.mutateAsync({ userId: user.id, body: { status: next } });
      message.success(next === "disabled" ? "已封禁，该用户所有会话立即失效" : "已解封");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "操作失败");
    }
  };

  return (
    <>
      <Space className={styles.toolbar}>
        <Input.Search allowClear placeholder="搜索邮箱或昵称" onSearch={setKeyword} style={{ width: 280 }} />
        <Button icon={<RefreshCw size={14} />} onClick={() => void users.refetch()}>
          刷新
        </Button>
        <Button type="primary" icon={<Plus size={14} />} onClick={() => setCreateOpen(true)} disabled={!canWrite}>
          新建用户
        </Button>
      </Space>
      <Table<AdminUser>
        rowKey="id"
        size="small"
        loading={users.isPending}
        dataSource={users.data?.items ?? []}
        pagination={false}
        columns={[
          { title: "邮箱", dataIndex: "email", ellipsis: true },
          { title: "昵称", dataIndex: "displayName", width: 140 },
          { title: "角色", dataIndex: "role", width: 100, render: (value: string) => <Tag>{roleLabel(value)}</Tag> },
          {
            title: "状态",
            dataIndex: "status",
            width: 90,
            render: (value: string) => (value === "active" ? <Tag color="green">正常</Tag> : <Tag color="red">已封禁</Tag>),
          },
          { title: "余额（积分）", width: 120, render: (_, user) => formatCredits(user.balanceMicrocredits) },
          {
            title: "操作",
            width: 320,
            render: (_, user) => (
              <Space size={4}>
                <Button size="small" type="link" onClick={() => setAdjustTarget(user)} disabled={!canWrite}>
                  调整积分
                </Button>
                <Button size="small" type="link" onClick={() => setLedgerTarget(user)}>
                  流水
                </Button>
                <Popconfirm
                  title="重置该用户密码？"
                  description="重置后其全部会话立即失效。"
                  onConfirm={() => void resetUserPassword(user)}
                  disabled={!canWrite}
                >
                  <Button size="small" type="link" disabled={!canWrite}>
                    重置密码
                  </Button>
                </Popconfirm>
                <Popconfirm
                  title={user.status === "active" ? "封禁该用户？" : "解封该用户？"}
                  description={user.status === "active" ? "封禁后其所有会话立即失效。" : undefined}
                  onConfirm={() => void toggleStatus(user)}
                  disabled={!canWrite}
                >
                  <Button size="small" type="link" danger={user.status === "active"} disabled={!canWrite}>
                    {user.status === "active" ? "封禁" : "解封"}
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />

      <CreateUserModal open={createOpen} onClose={() => setCreateOpen(false)} />
      <AdjustCreditsModal target={adjustTarget} onClose={() => setAdjustTarget(null)} />
      <LedgerModal target={ledgerTarget} onClose={() => setLedgerTarget(null)} />
    </>
  );
}

function CreateUserModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ email: string; displayName?: string; role: AdminRole; password?: string; credits?: number }>();
  const create = useCreateAdminUser();

  const submit = async () => {
    const values = await form.validateFields();
    try {
      const created = await create.mutateAsync({
        email: values.email,
        displayName: values.displayName,
        role: values.role,
        password: values.password || undefined,
        credits: values.credits ?? 0,
      });
      form.resetFields();
      onClose();
      // 生成的一次性密码只在这里出现一次：必须显式展示并提示管理员立刻抄走。
      if (created.generatedPassword) {
        Modal.success({
          title: "用户已创建",
          content: (
            <div>
              <p>请立刻把下面的初始密码交给用户，关闭后无法再次查看：</p>
              <Typography.Text code copyable={{ text: created.generatedPassword }}>
                {created.generatedPassword}
              </Typography.Text>
            </div>
          ),
        });
      } else {
        message.success("用户已创建");
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : "创建失败");
    }
  };

  return (
    <Modal open={open} title="新建用户" onCancel={onClose} onOk={() => void submit()} confirmLoading={create.isPending} okText="创建" destroyOnClose>
      <Form form={form} layout="vertical" initialValues={{ role: "user" }} preserve={false}>
        <Form.Item name="email" label="邮箱" rules={[{ required: true, message: "填写邮箱" }, { type: "email", message: "邮箱格式不正确" }]}>
          <Input placeholder="user@example.com" autoComplete="off" />
        </Form.Item>
        <Form.Item name="displayName" label="昵称">
          <Input placeholder="留空则取邮箱前缀" autoComplete="off" />
        </Form.Item>
        <Form.Item name="role" label="角色" rules={[{ required: true }]}>
          <Select options={[{ value: "user", label: "用户" }, { value: "support", label: "客服（只读）" }, { value: "admin", label: "管理员" }]} />
        </Form.Item>
        <Form.Item name="password" label="初始密码" extra="留空则自动生成一次性密码，创建后展示一次。">
          <Input.Password placeholder="至少 8 位" autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="credits" label="初始积分" extra="可为 0；负数表示扣减。">
          <InputNumber style={{ width: "100%" }} step={1} precision={2} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function AdjustCreditsModal({ target, onClose }: { target: AdminUser | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ credits: number; note?: string }>();
  const adjust = useAdjustCredits();

  const submit = async () => {
    if (!target) return;
    const values = await form.validateFields();
    try {
      await adjust.mutateAsync({ userId: target.id, credits: values.credits, note: values.note });
      message.success("积分已调整");
      form.resetFields();
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "调整失败");
    }
  };

  return (
    <Modal open={Boolean(target)} title={`调整积分 · ${target?.email ?? ""}`} onCancel={onClose} onOk={() => void submit()} confirmLoading={adjust.isPending} okText="确认调整">
      <Typography.Paragraph type="secondary">正数发放，负数扣减。当前余额 {formatCredits(target?.balanceMicrocredits)} 积分。</Typography.Paragraph>
      <Form form={form} layout="vertical" initialValues={{ credits: 1 }}>
        <Form.Item name="credits" label="调整数量（积分）" rules={[{ required: true, message: "填写调整数量" }]}>
          <InputNumber style={{ width: "100%" }} step={0.5} precision={2} />
        </Form.Item>
        <Form.Item name="note" label="备注">
          <Input placeholder="例如：工单补偿 / 冲正" maxLength={120} />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function LedgerModal({ target, onClose }: { target: AdminUser | null; onClose: () => void }) {
  const ledger = useAdminLedger(target?.id ?? null);
  const drift = ledger.data ? ledger.data.balance.stored !== ledger.data.balance.computed : false;

  return (
    <Modal open={Boolean(target)} title={`积分流水 · ${target?.email ?? ""}`} onCancel={onClose} footer={null} width={860}>
      {drift ? (
        <Typography.Paragraph type="danger">
          账目漂移：缓存余额 {formatCredits(ledger.data?.balance.stored)}，流水重算 {formatCredits(ledger.data?.balance.computed)}。
        </Typography.Paragraph>
      ) : null}
      <Table
        rowKey="id"
        size="small"
        loading={ledger.isPending}
        dataSource={ledger.data?.items ?? []}
        pagination={false}
        columns={[
          { title: "时间", dataIndex: "createdAt", width: 190, render: (value: string) => new Date(value).toLocaleString() },
          { title: "类型", dataIndex: "type", width: 130 },
          {
            title: "变动",
            dataIndex: "amountMicrocredits",
            width: 100,
            render: (value: number) => <span style={{ color: value < 0 ? "#c0392b" : "#1e8449" }}>{value > 0 ? "+" : ""}{formatCredits(value)}</span>,
          },
          { title: "余额", dataIndex: "balanceAfterMicrocredits", width: 100, render: (value: number) => formatCredits(value) },
          { title: "备注", dataIndex: "note", ellipsis: true },
        ]}
      />
    </Modal>
  );
}

// ---------------- 待裁决计费单 ----------------

function UncertainPanel({ canWrite }: { canWrite: boolean }) {
  const { message } = AntdApp.useApp();
  const orders = useAdminUncertainOrders();
  const resolve = useResolveOrder();

  const act = async (jobId: string, action: "settle" | "refund") => {
    try {
      await resolve.mutateAsync({ jobId, action });
      message.success(action === "refund" ? "已退回积分" : "已按预扣额结算");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "裁决失败");
    }
  };

  if (orders.isPending) return <Spin />;
  if ((orders.data?.items.length ?? 0) === 0) {
    return <Empty description="没有待裁决的计费单。这类订单来自「外部请求已发出但结果未知」的任务。" />;
  }

  return (
    <Table
      rowKey="id"
      size="small"
      dataSource={orders.data?.items ?? []}
      pagination={false}
      columns={[
        { title: "用户", width: 220, render: (_, order) => order.user?.email ?? order.userId },
        { title: "任务", dataIndex: "jobId", width: 300, ellipsis: true },
        { title: "预扣（积分）", dataIndex: "reservedMicrocredits", width: 120, render: (value: number) => formatCredits(value) },
        { title: "发生时间", dataIndex: "updatedAt", width: 190, render: (value: string) => new Date(value).toLocaleString() },
        {
          title: "裁决",
          width: 200,
          render: (_, order) => (
            <Space size={4}>
              <Popconfirm title="按预扣额结算？" description="Provider 已计费，用户承担全额。" onConfirm={() => void act(order.jobId, "settle")} disabled={!canWrite}>
                <Button size="small" disabled={!canWrite}>结算</Button>
              </Popconfirm>
              <Popconfirm title="全额退回？" description="确认 Provider 未计费时才这样做。" onConfirm={() => void act(order.jobId, "refund")} disabled={!canWrite}>
                <Button size="small" danger disabled={!canWrite}>退款</Button>
              </Popconfirm>
            </Space>
          ),
        },
      ]}
    />
  );
}

// ---------------- 价目 ----------------

function PricesPanel({ canWrite }: { canWrite: boolean }) {
  const { message } = AntdApp.useApp();
  const prices = useAdminPrices();
  const deletePrice = useDeletePrice();
  const [creating, setCreating] = useState(false);

  const remove = async (price: PriceRecord) => {
    try {
      await deletePrice.mutateAsync(price);
      message.success("已删除价目");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "删除失败");
    }
  };

  return (
    <>
      <Space className={styles.toolbar}>
        <Button type="primary" icon={<Plus size={14} />} onClick={() => setCreating(true)} disabled={!canWrite}>
          新增价目
        </Button>
        <Button icon={<RefreshCw size={14} />} onClick={() => void prices.refetch()}>
          刷新
        </Button>
        <Typography.Text type="secondary">没配价目的模型无法出图——平台代付模式下不能白送算力。</Typography.Text>
      </Space>
      <Table<PriceRecord>
        rowKey="id"
        size="small"
        loading={prices.isPending}
        dataSource={prices.data?.items ?? []}
        pagination={false}
        columns={[
          { title: "Provider", dataIndex: "providerId", ellipsis: true },
          { title: "模型", dataIndex: "modelId", width: 180, ellipsis: true },
          { title: "类型", dataIndex: "kind", width: 110 },
          { title: "计价方式", dataIndex: "pricingMode", width: 140 },
          { title: "售价（积分）", dataIndex: "priceMicrocredits", width: 120, render: (value: number) => formatCredits(value) },
          { title: "成本（积分）", dataIndex: "costMicrocredits", width: 120, render: (value: number) => formatCredits(value) },
          { title: "档位", width: 180, render: (_, price) => (Object.keys(price.tiers).length ? Object.entries(price.tiers).map(([k, v]) => `${k}:${formatCredits(v)}`).join(" / ") : "—") },
          {
            title: "操作",
            width: 90,
            render: (_, price) => (
              <Popconfirm title="删除该价目？" onConfirm={() => void remove(price)} disabled={!canWrite}>
                <Button size="small" type="link" danger disabled={!canWrite}>删除</Button>
              </Popconfirm>
            ),
          },
        ]}
      />
      <CreatePriceModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

function CreatePriceModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const upsert = useUpsertPrice();

  const submit = async () => {
    const values = await form.validateFields();
    let tiers: Record<string, number> = {};
    if (values.tiers) {
      try {
        tiers = JSON.parse(values.tiers) as Record<string, number>;
      } catch {
        message.error("档位必须是合法 JSON，例如 {\"1K\":400000}");
        return;
      }
    }
    try {
      await upsert.mutateAsync({
        providerId: values.providerId,
        modelId: values.modelId,
        kind: values.kind,
        pricingMode: values.pricingMode,
        priceMicrocredits: Math.round(Number(values.price) * 1_000_000),
        costMicrocredits: Math.round(Number(values.cost ?? 0) * 1_000_000),
        tiers,
        active: true,
      });
      message.success("价目已保存");
      form.resetFields();
      onClose();
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  return (
    <Modal open={open} title="新增 / 覆盖价目" onCancel={onClose} onOk={() => void submit()} confirmLoading={upsert.isPending} okText="保存">
      <Form form={form} layout="vertical" initialValues={{ kind: "image", pricingMode: "per_image", price: 0.4, cost: 0 }}>
        <Form.Item name="providerId" label="Provider ID" rules={[{ required: true, message: "填写 Provider ID" }]}>
          <Input placeholder="在「设置 · Provider」里复制" />
        </Form.Item>
        <Form.Item name="modelId" label="模型 ID" rules={[{ required: true, message: "填写模型 ID" }]}>
          <Input placeholder="例如 gemini-2.5-flash-image" />
        </Form.Item>
        <Form.Item name="kind" label="用途">
          <Select options={[{ value: "image", label: "生图" }, { value: "reasoning", label: "推理" }, { value: "segmentation", label: "分割" }]} />
        </Form.Item>
        <Form.Item name="pricingMode" label="计价方式">
          <Select options={[{ value: "fixed_request", label: "按次" }, { value: "per_image", label: "按张" }, { value: "per_resolution", label: "按分辨率" }, { value: "token", label: "按 token" }]} />
        </Form.Item>
        <Form.Item name="price" label="售价（积分）" rules={[{ required: true, message: "填写售价" }]}>
          <InputNumber style={{ width: "100%" }} step={0.1} precision={4} min={0} />
        </Form.Item>
        <Form.Item name="cost" label="成本（积分，仅内部核算）">
          <InputNumber style={{ width: "100%" }} step={0.1} precision={4} min={0} />
        </Form.Item>
        <Form.Item name="tiers" label="分辨率档位（按分辨率计价时必填）">
          <Input.TextArea rows={2} placeholder='{"1K":400000,"2K":900000}' />
        </Form.Item>
      </Form>
    </Modal>
  );
}

// ---------------- 审计 ----------------

function PaymentPanel({ canWrite }: { canWrite: boolean }) {
  const { message } = AntdApp.useApp();
  const config = usePaymentConfig();
  const update = useUpdatePaymentConfig();
  const [form] = Form.useForm<{
    gateway: string;
    pid: string;
    key?: string;
    payType: string;
    pricePerCreditCents: number;
    publicBaseUrl?: string;
  }>();

  if (config.isPending) return <Spin />;

  const data = config.data;

  const submit = async () => {
    const values = await form.validateFields();
    try {
      await update.mutateAsync({
        gateway: values.gateway,
        pid: values.pid,
        // 留空表示不轮换：管理端拿不到原密钥，把空串提交上去会把已配置的渠道清坏。
        key: values.key?.trim() ? values.key : undefined,
        payType: values.payType,
        pricePerCreditCents: values.pricePerCreditCents,
        publicBaseUrl: values.publicBaseUrl?.trim() ? values.publicBaseUrl : undefined,
      });
      message.success("支付配置已保存");
      form.setFieldValue("key", undefined);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  return (
    <div className={styles.panelBody}>
      {!data?.hasKey ? (
        <Alert
          type="warning"
          showIcon
          message="尚未配置支付渠道"
          description="未配置前用户无法充值：下单会直接返回「支付渠道尚未配置」。"
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 560 }}
        initialValues={{
          gateway: data?.gateway ?? "",
          pid: data?.pid ?? "",
          payType: data?.payType ?? "alipay",
          pricePerCreditCents: data?.pricePerCreditCents ?? 100,
          publicBaseUrl: data?.publicBaseUrl ?? "",
        }}
      >
        <Form.Item name="gateway" label="网关地址" rules={[{ required: true, message: "填写网关地址" }]} extra="易支付站点根地址，例如 https://pay.example.com/">
          <Input placeholder="https://pay.example.com/" disabled={!canWrite} autoComplete="off" />
        </Form.Item>
        <Form.Item name="pid" label="商户号 PID" rules={[{ required: true, message: "填写商户号" }]}>
          <Input placeholder="1001" disabled={!canWrite} autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="key"
          label="商户密钥"
          extra={data?.hasKey ? "已配置。留空则不修改；填写则轮换。" : "尚未配置，必须填写。"}
          rules={data?.hasKey ? [] : [{ required: true, message: "填写商户密钥" }]}
        >
          <Input.Password placeholder={data?.hasKey ? "留空则不修改" : "必填"} disabled={!canWrite} autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="payType" label="支付方式">
          <Select
            disabled={!canWrite}
            options={[
              { value: "alipay", label: "支付宝" },
              { value: "wxpay", label: "微信支付" },
            ]}
          />
        </Form.Item>
        <Form.Item name="pricePerCreditCents" label="积分单价（分）" rules={[{ required: true, message: "填写单价" }]} extra="用户充值页展示的价格直接来自这里，改完立即生效。">
          <InputNumber min={1} precision={0} style={{ width: "100%" }} disabled={!canWrite} />
        </Form.Item>
        <Form.Item
          name="publicBaseUrl"
          label="公网访问地址"
          extra="网关回调地址由它派生，必须是网关能访问到的公网地址；留空则按请求来源推断（本地 127.0.0.1 收不到回调）。"
        >
          <Input placeholder="https://your-domain.com" disabled={!canWrite} autoComplete="off" />
        </Form.Item>
        <Button type="primary" onClick={() => void submit()} loading={update.isPending} disabled={!canWrite}>
          保存配置
        </Button>
      </Form>
    </div>
  );
}

function MailPanel({ canWrite }: { canWrite: boolean }) {
  const { message } = AntdApp.useApp();
  const settings = useMailSettings();
  const update = useUpdateMailSettings();
  const test = useTestMailSettings();
  const [form] = Form.useForm<{
    host: string;
    port: number;
    secure: boolean;
    requireStartTls: boolean;
    user?: string;
    pass?: string;
    from: string;
    fromName?: string;
  }>();

  if (settings.isPending) return <Spin />;

  const data = settings.data;

  const submit = async () => {
    const values = await form.validateFields();
    try {
      await update.mutateAsync({
        host: values.host,
        port: values.port,
        secure: values.secure,
        requireStartTls: values.requireStartTls,
        user: values.user ?? "",
        // 留空表示不轮换：管理端拿不到原口令，提交空串会把已配置的服务器清坏。
        pass: values.pass?.trim() ? values.pass : undefined,
        from: values.from,
        fromName: values.fromName ?? "",
      });
      message.success("邮件配置已保存");
      form.setFieldValue("pass", undefined);
    } catch (error) {
      message.error(error instanceof Error ? error.message : "保存失败");
    }
  };

  const runTest = async () => {
    try {
      await test.mutateAsync();
      message.success("连接与认证通过");
    } catch (error) {
      message.error(error instanceof Error ? error.message : "连接失败");
    }
  };

  return (
    <div className={styles.panelBody}>
      {!data?.configured ? (
        <Alert
          type="warning"
          showIcon
          message="尚未配置邮件服务器"
          description="未配置时用户无法自助找回密码：重置令只会写进服务端日志，需要管理员手工转发。"
          style={{ marginBottom: 16 }}
        />
      ) : null}

      <Form
        form={form}
        layout="vertical"
        style={{ maxWidth: 560 }}
        initialValues={{
          host: data?.host ?? "",
          port: data?.port ?? 587,
          secure: data?.secure ?? false,
          requireStartTls: data?.requireStartTls ?? true,
          user: data?.user ?? "",
          from: data?.from ?? "",
          fromName: data?.fromName ?? "",
        }}
      >
        <Form.Item name="host" label="服务器地址" rules={[{ required: true, message: "填写 SMTP 服务器地址" }]}>
          <Input placeholder="smtp.example.com" disabled={!canWrite} autoComplete="off" />
        </Form.Item>
        <Form.Item name="port" label="端口" rules={[{ required: true, message: "填写端口" }]} extra="465 通常用隐式 TLS；587/25 用 STARTTLS。">
          <InputNumber min={1} max={65535} precision={0} style={{ width: "100%" }} disabled={!canWrite} />
        </Form.Item>
        <Form.Item name="secure" label="隐式 TLS（465）" valuePropName="checked" extra="关闭时先明文连接再升级；服务器不提供 STARTTLS 会拒绝投递。">
          <Switch disabled={!canWrite} />
        </Form.Item>
        <Form.Item name="requireStartTls" label="强制 STARTTLS" valuePropName="checked" extra="仅受信任的内网中继才该关闭——明文投递会暴露重置链接。">
          <Switch disabled={!canWrite} />
        </Form.Item>
        <Form.Item name="user" label="账号" extra="多数服务商用完整邮箱作为账号。">
          <Input disabled={!canWrite} autoComplete="off" />
        </Form.Item>
        <Form.Item
          name="pass"
          label="口令 / 授权码"
          extra={data?.hasPass ? "已配置。留空则不修改；填写则轮换。" : "尚未配置。"}
        >
          <Input.Password placeholder={data?.hasPass ? "留空则不修改" : ""} disabled={!canWrite} autoComplete="new-password" />
        </Form.Item>
        <Form.Item name="from" label="发件地址" rules={[{ required: true, message: "填写发件地址" }]}>
          <Input placeholder="no-reply@example.com" disabled={!canWrite} autoComplete="off" />
        </Form.Item>
        <Form.Item name="fromName" label="发件人名称">
          <Input placeholder="EcomGen" disabled={!canWrite} autoComplete="off" />
        </Form.Item>
        <Space>
          <Button type="primary" onClick={() => void submit()} loading={update.isPending} disabled={!canWrite}>
            保存配置
          </Button>
          <Button onClick={() => void runTest()} loading={test.isPending} disabled={!data?.configured}>
            测试连接
          </Button>
        </Space>
      </Form>
    </div>
  );
}

function AuditPanel() {
  const audit = useAdminAudit();
  return (
    <Table
      rowKey="id"
      size="small"
      loading={audit.isPending}
      dataSource={audit.data?.items ?? []}
      pagination={false}
      columns={[
        { title: "时间", dataIndex: "created_at", width: 190, render: (value: string) => new Date(value).toLocaleString() },
        { title: "动作", dataIndex: "action", width: 180 },
        { title: "对象", width: 220, render: (_, row) => `${row.target_type}${row.target_id ? ` · ${row.target_id}` : ""}` },
        { title: "摘要", dataIndex: "summary", ellipsis: true },
        { title: "操作人", dataIndex: "actor_user_id", width: 300, ellipsis: true },
      ]}
    />
  );
}

function roleLabel(role: string): string {
  switch (role) {
    case "owner":
      return "站长";
    case "admin":
      return "管理员";
    case "support":
      return "客服";
    default:
      return "普通用户";
  }
}
