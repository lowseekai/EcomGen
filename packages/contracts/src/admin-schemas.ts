import { Type } from "@sinclair/typebox";

import { ImageResolution } from "./enums.js";
import { schemaRef } from "./ref.js";

/**
 * 管理后台与充值的契约。
 *
 * 这批端点最初是手工校验 + 手写前端类型的，改字段不会有人报错。收进契约后
 * 前后端都以这里为真相源，生成物由 `pnpm gen:openapi` 与 `pnpm --filter @ecomgen/web gen:api` 产出。
 */

// ---------------- 共用 ----------------

export const AdminRole = Type.Union(
  [Type.Literal("owner"), Type.Literal("admin"), Type.Literal("support"), Type.Literal("user")],
  { $id: "#/components/schemas/AdminRole" },
);

export const AdminUserStatus = Type.Union([Type.Literal("active"), Type.Literal("disabled")], {
  $id: "#/components/schemas/AdminUserStatus",
});

export const AdminUser = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    email: Type.String(),
    displayName: Type.String(),
    role: schemaRef(AdminRole),
    status: schemaRef(AdminUserStatus),
    emailVerifiedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    balanceMicrocredits: Type.Integer(),
  },
  { $id: "#/components/schemas/AdminUser" },
);

export const AdminUserList = Type.Object(
  {
    items: Type.Array(schemaRef(AdminUser)),
    total: Type.Integer(),
    limit: Type.Integer(),
    offset: Type.Integer(),
  },
  { $id: "#/components/schemas/AdminUserList" },
);

export const AdminUserPatchInput = Type.Object(
  {
    displayName: Type.Optional(Type.String()),
    role: Type.Optional(schemaRef(AdminRole)),
    status: Type.Optional(schemaRef(AdminUserStatus)),
  },
  { $id: "#/components/schemas/AdminUserPatchInput" },
);

export const AdminCreateUserInput = Type.Object(
  {
    email: Type.String(),
    displayName: Type.Optional(Type.String()),
    role: Type.Optional(schemaRef(AdminRole)),
    /** 留空则由服务端生成一次性密码，只在响应里返回一次。 */
    password: Type.Optional(Type.String()),
    credits: Type.Optional(Type.Number()),
  },
  { $id: "#/components/schemas/AdminCreateUserInput" },
);

export const AdminCreateUserResult = Type.Composite(
  [
    schemaRef(AdminUser),
    Type.Object({
      /** 仅当服务端生成密码时存在；关闭后无法再次获取。 */
      generatedPassword: Type.Optional(Type.String()),
    }),
  ],
  { $id: "#/components/schemas/AdminCreateUserResult" },
);

export const AdminPasswordResetInput = Type.Object(
  { password: Type.Optional(Type.String()) },
  { $id: "#/components/schemas/AdminPasswordResetInput" },
);

export const AdminPasswordResetResult = Type.Object(
  {
    revokedSessions: Type.Integer(),
    generatedPassword: Type.Optional(Type.String()),
  },
  { $id: "#/components/schemas/AdminPasswordResetResult" },
);

export const AdminCreditAdjustInput = Type.Object(
  {
    /** 正数发放、负数扣减；单位是「积分」，服务端换算成微积分。 */
    credits: Type.Number(),
    note: Type.Optional(Type.String()),
  },
  { $id: "#/components/schemas/AdminCreditAdjustInput" },
);

export const AdminCreditAdjustResult = Type.Object(
  { balanceMicrocredits: Type.Integer() },
  { $id: "#/components/schemas/AdminCreditAdjustResult" },
);

export const CreditLedgerEntry = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    userId: Type.String({ format: "uuid" }),
    type: Type.String(),
    amountMicrocredits: Type.Integer(),
    balanceAfterMicrocredits: Type.Integer(),
    jobId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    projectId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    note: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ format: "date-time" }),
  },
  { $id: "#/components/schemas/CreditLedgerEntry" },
);

export const CreditLedgerPage = Type.Object(
  {
    items: Type.Array(schemaRef(CreditLedgerEntry)),
    total: Type.Integer(),
    /** stored 与 computed 不一致即账目漂移。 */
    balance: Type.Object({ stored: Type.Integer(), computed: Type.Integer() }),
    limit: Type.Integer(),
    offset: Type.Integer(),
  },
  { $id: "#/components/schemas/CreditLedgerPage" },
);

/** 套餐权益：全部对应产品里已有的能力，新增权益时这里与 planRepository 必须同步。 */
export const Entitlements = Type.Object(
  {
    monthlyCredits: Type.Integer(),
    maxProjects: Type.Integer({ description: "-1 表示不限。" }),
    maxConcurrentJobs: Type.Integer(),
    maxImageResolution: schemaRef(ImageResolution),
    maxStorageBytes: Type.Integer({ description: "-1 表示不限。" }),
    allowPsdExport: Type.Boolean(),
    allowLayerExport: Type.Boolean(),
    allowWebResearch: Type.Boolean(),
    allowSuiteForge: Type.Boolean(),
    allowModelLibrary: Type.Boolean(),
    allowPatternStudio: Type.Boolean(),
    watermarkExports: Type.Boolean(),
  },
  { $id: "#/components/schemas/Entitlements" },
);

export const UserSessionSummary = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    createdAt: Type.String({ format: "date-time" }),
    lastSeenAt: Type.String({ format: "date-time" }),
    expiresAt: Type.String({ format: "date-time" }),
    revokedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    userAgent: Type.Union([Type.String(), Type.Null()]),
    ip: Type.Union([Type.String(), Type.Null()]),
  },
  { $id: "#/components/schemas/UserSessionSummary" },
);

export const AdminUserDetail = Type.Composite(
  [
    schemaRef(AdminUser),
    Type.Object({
      activeSubscription: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
      entitlements: Type.Object({ entitlements: schemaRef(Entitlements), planCode: Type.String() }),
      sessions: Type.Array(schemaRef(UserSessionSummary)),
    }),
  ],
  { $id: "#/components/schemas/AdminUserDetail" },
);

// ---------------- 计费裁决 ----------------

export const BillingStatus = Type.Union(
  [
    Type.Literal("reserved"),
    Type.Literal("settled"),
    Type.Literal("refunded"),
    Type.Literal("uncertain"),
  ],
  { $id: "#/components/schemas/BillingStatus" },
);

export const BillingOrder = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    userId: Type.String({ format: "uuid" }),
    jobId: Type.String({ format: "uuid" }),
    status: schemaRef(BillingStatus),
    reservedMicrocredits: Type.Integer(),
    settledMicrocredits: Type.Union([Type.Integer(), Type.Null()]),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { $id: "#/components/schemas/BillingOrder" },
);

export const UncertainBillingOrder = Type.Composite(
  [schemaRef(BillingOrder), Type.Object({ user: Type.Union([schemaRef(AdminUser), Type.Null()]) })],
  { $id: "#/components/schemas/UncertainBillingOrder" },
);

export const UncertainBillingOrderList = Type.Object(
  {
    items: Type.Array(schemaRef(UncertainBillingOrder)),
    limit: Type.Integer(),
    offset: Type.Integer(),
  },
  { $id: "#/components/schemas/UncertainBillingOrderList" },
);

export const ResolveBillingOrderInput = Type.Object(
  {
    action: Type.Union([Type.Literal("settle"), Type.Literal("refund")]),
    /** action=settle 时按此金额结算，缺省用预扣额。 */
    settledMicrocredits: Type.Optional(Type.Integer()),
    note: Type.Optional(Type.String()),
  },
  { $id: "#/components/schemas/ResolveBillingOrderInput" },
);

// ---------------- 价目 ----------------

export const PricingMode = Type.Union(
  [Type.Literal("fixed_request"), Type.Literal("per_image"), Type.Literal("per_resolution"), Type.Literal("token")],
  { $id: "#/components/schemas/PricingMode" },
);

export const ProviderModelPrice = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    providerId: Type.String({ format: "uuid" }),
    modelId: Type.String(),
    kind: Type.String(),
    pricingMode: schemaRef(PricingMode),
    priceMicrocredits: Type.Integer(),
    /** 平台成本，仅后台可见。 */
    costMicrocredits: Type.Integer(),
    tiers: Type.Record(Type.String(), Type.Integer()),
    active: Type.Boolean(),
  },
  { $id: "#/components/schemas/ProviderModelPrice" },
);

export const ProviderModelPriceList = Type.Object(
  { items: Type.Array(schemaRef(ProviderModelPrice)) },
  { $id: "#/components/schemas/ProviderModelPriceList" },
);

export const UpsertProviderModelPriceInput = Type.Object(
  {
    providerId: Type.String({ format: "uuid" }),
    modelId: Type.String(),
    kind: Type.String(),
    pricingMode: schemaRef(PricingMode),
    priceMicrocredits: Type.Optional(Type.Integer()),
    costMicrocredits: Type.Optional(Type.Integer()),
    tiers: Type.Optional(Type.Record(Type.String(), Type.Integer())),
    active: Type.Optional(Type.Boolean()),
  },
  { $id: "#/components/schemas/UpsertProviderModelPriceInput" },
);

// ---------------- 审计 ----------------

/** 审计行直接来自数据库，列名保持 snake_case；改列名会破坏已有导出与查询。 */
export const AuditEvent = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    actor_user_id: Type.String({ format: "uuid" }),
    action: Type.String(),
    target_type: Type.String(),
    target_id: Type.Union([Type.String(), Type.Null()]),
    summary: Type.String(),
    created_at: Type.String({ format: "date-time" }),
  },
  { $id: "#/components/schemas/AuditEvent" },
);

export const AuditEventList = Type.Object(
  {
    items: Type.Array(schemaRef(AuditEvent)),
    limit: Type.Integer(),
    offset: Type.Integer(),
  },
  { $id: "#/components/schemas/AuditEventList" },
);

// ---------------- 支付配置 ----------------

export const PaymentConfig = Type.Object(
  {
    provider: Type.Union([Type.String(), Type.Null()]),
    /** 密钥永不回显，只表示是否已配置。 */
    hasKey: Type.Boolean(),
    gateway: Type.Union([Type.String(), Type.Null()]),
    pid: Type.Union([Type.String(), Type.Null()]),
    payType: Type.String(),
    pricePerCreditCents: Type.Integer(),
    publicBaseUrl: Type.String(),
  },
  { $id: "#/components/schemas/PaymentConfig" },
);

export const PaymentConfigInput = Type.Object(
  {
    gateway: Type.Optional(Type.String()),
    pid: Type.Optional(Type.String()),
    /** 只在轮换密钥时传；不传则保留原值。 */
    key: Type.Optional(Type.String()),
    payType: Type.Optional(Type.String()),
    pricePerCreditCents: Type.Optional(Type.Integer()),
    publicBaseUrl: Type.Optional(Type.String()),
  },
  { $id: "#/components/schemas/PaymentConfigInput" },
);

export const PaymentConfigUpdateResult = Type.Object(
  { ok: Type.Boolean(), hasKey: Type.Boolean() },
  { $id: "#/components/schemas/PaymentConfigUpdateResult" },
);

// ---------------- 充值（面向所有登录用户） ----------------

export const PaymentOrderStatus = Type.Union(
  [
    Type.Literal("created"),
    Type.Literal("pending"),
    Type.Literal("paid"),
    Type.Literal("closed"),
    Type.Literal("failed"),
  ],
  { $id: "#/components/schemas/PaymentOrderStatus" },
);

export const PaymentOrder = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    kind: Type.String(),
    /** 积分（不是微积分）：服务端已换算。 */
    credits: Type.Number(),
    amountCents: Type.Integer(),
    currency: Type.String(),
    status: schemaRef(PaymentOrderStatus),
    provider: Type.String(),
    tradeNo: Type.Union([Type.String(), Type.Null()]),
    paidAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    creditedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    expiresAt: Type.String({ format: "date-time" }),
    createdAt: Type.String({ format: "date-time" }),
  },
  { $id: "#/components/schemas/PaymentOrder" },
);

export const PaymentOrderList = Type.Object(
  {
    items: Type.Array(schemaRef(PaymentOrder)),
    /** 1 积分 = 多少分钱；前端展示价格以此为准，不写死。 */
    pricePerCreditCents: Type.Integer(),
    limit: Type.Integer(),
    offset: Type.Integer(),
  },
  { $id: "#/components/schemas/PaymentOrderList" },
);

export const CreateTopupOrderInput = Type.Object(
  { credits: Type.Number({ exclusiveMinimum: 0 }) },
  { $id: "#/components/schemas/CreateTopupOrderInput" },
);

export const CreateTopupOrderResult = Type.Object(
  {
    order: schemaRef(PaymentOrder),
    checkoutUrl: Type.String(),
  },
  { $id: "#/components/schemas/CreateTopupOrderResult" },
);

// ---------------- 运营：仪表盘 / 套餐 / 支付订单与对账 ----------------

export const AdminDashboard = Type.Object(
  {
    users: Type.Object({ total: Type.Integer(), active: Type.Integer(), disabled: Type.Integer() }),
    projects: Type.Object({ total: Type.Integer(), active: Type.Integer() }),
    jobs: Type.Object({
      total: Type.Integer(),
      queued: Type.Integer(),
      running: Type.Integer(),
      succeeded: Type.Integer(),
      failed: Type.Integer(),
      cancelled: Type.Integer(),
    }),
    billing: Type.Object({
      reserved: Type.Integer(),
      uncertain: Type.Integer(),
      settled: Type.Integer(),
      refunded: Type.Integer(),
      settledMicrocredits: Type.Integer(),
    }),
    credits: Type.Object({
      issuedMicrocredits: Type.Integer(),
      spentMicrocredits: Type.Integer(),
      toppedUpMicrocredits: Type.Integer(),
    }),
    payments: Type.Object({ pending: Type.Integer(), paid: Type.Integer(), creditedMicrocredits: Type.Integer() }),
    storage: Type.Object({ patterns: Type.Integer(), models: Type.Integer(), assets: Type.Integer(), outputs: Type.Integer() }),
    /** 微积分是真相，这里是给人看的积分口径。 */
    display: Type.Object({
      settledCredits: Type.Number(),
      toppedUpCredits: Type.Number(),
      spentCredits: Type.Number(),
    }),
  },
  { $id: "#/components/schemas/AdminDashboard" },
);

export const BillingPeriod = Type.Union([Type.Literal("none"), Type.Literal("month"), Type.Literal("year")], {
  $id: "#/components/schemas/BillingPeriod",
});

/**
 * 权益的"可部分更新"形态。
 *
 * 不能写成 `Type.Partial(schemaRef(Entitlements))`：TypeBox 会把 $ref 包进 allOf，
 * 生成的 JSON Schema 多出 target/parameters 两个非法键，Redocly 直接判错。
 * 显式列出可选键是最稳的写法。
 */
export const PlanEntitlements = Type.Object(
  {
    monthlyCredits: Type.Optional(Type.Integer()),
    maxProjects: Type.Optional(Type.Integer()),
    maxConcurrentJobs: Type.Optional(Type.Integer()),
    maxImageResolution: Type.Optional(Type.String()),
    maxStorageBytes: Type.Optional(Type.Integer()),
    allowPsdExport: Type.Optional(Type.Boolean()),
    allowLayerExport: Type.Optional(Type.Boolean()),
    allowWebResearch: Type.Optional(Type.Boolean()),
    allowSuiteForge: Type.Optional(Type.Boolean()),
    allowModelLibrary: Type.Optional(Type.Boolean()),
    allowPatternStudio: Type.Optional(Type.Boolean()),
    watermarkExports: Type.Optional(Type.Boolean()),
  },
  { $id: "#/components/schemas/PlanEntitlements" },
);

export const Plan = Type.Object(
  {
    // 套餐 id 是稳定 slug（plan-free / plan-pro），不是 UUID：它跨环境一致，
    // 订阅与权益行都按它外键。声明成 uuid 会让契约说谎。
    id: Type.String({ description: "套餐标识，稳定 slug（如 plan-free），跨环境一致。" }),
    code: Type.String(),
    name: Type.String(),
    description: Type.String(),
    priceCents: Type.Integer(),
    currency: Type.String(),
    billingPeriod: schemaRef(BillingPeriod),
    active: Type.Boolean(),
    sortOrder: Type.Integer(),
    entitlements: schemaRef(PlanEntitlements),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
  },
  { $id: "#/components/schemas/Plan" },
);

export const PlanList = Type.Object({ items: Type.Array(schemaRef(Plan)) }, { $id: "#/components/schemas/PlanList" });

export const AdminPlanPatchInput = Type.Object(
  {
    name: Type.Optional(Type.String()),
    description: Type.Optional(Type.String()),
    priceCents: Type.Optional(Type.Integer()),
    billingPeriod: Type.Optional(schemaRef(BillingPeriod)),
    active: Type.Optional(Type.Boolean()),
    sortOrder: Type.Optional(Type.Integer()),
    /** 浅合并：只传变化的键，不传的保持原值。 */
    entitlements: Type.Optional(schemaRef(PlanEntitlements)),
  },
  { $id: "#/components/schemas/AdminPlanPatchInput" },
);

export const AdminPaymentOrder = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    userId: Type.String({ format: "uuid" }),
    kind: Type.String(),
    planId: Type.Union([Type.String({ format: "uuid" }), Type.Null()]),
    creditsMicrocredits: Type.Integer(),
    /** 与 creditsMicrocredits 同值的积分口径。 */
    credits: Type.Number(),
    amountCents: Type.Integer(),
    currency: Type.String(),
    status: schemaRef(PaymentOrderStatus),
    provider: Type.String(),
    /** 下单时的渠道配置快照；密钥在创建时就已剥离。 */
    providerConfig: Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Null()]),
    providerOrderNo: Type.Union([Type.String(), Type.Null()]),
    providerTradeNo: Type.Union([Type.String(), Type.Null()]),
    paidAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    creditedAt: Type.Union([Type.String({ format: "date-time" }), Type.Null()]),
    expiresAt: Type.String({ format: "date-time" }),
    createdAt: Type.String({ format: "date-time" }),
    updatedAt: Type.String({ format: "date-time" }),
    user: Type.Union([schemaRef(AdminUser), Type.Null()]),
  },
  { $id: "#/components/schemas/AdminPaymentOrder" },
);

export const AdminPaymentOrderList = Type.Object(
  {
    items: Type.Array(schemaRef(AdminPaymentOrder)),
    limit: Type.Integer(),
    offset: Type.Integer(),
  },
  { $id: "#/components/schemas/AdminPaymentOrderList" },
);

/** 对账视图的行是数据库原始行（snake_case），刻意不做投影：这里要的是"原样看清"。 */
export const PaymentReconcile = Type.Object(
  {
    paidNotCredited: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    expiredUnpaid: Type.Array(Type.Record(Type.String(), Type.Unknown())),
    limit: Type.Integer(),
    offset: Type.Integer(),
  },
  { $id: "#/components/schemas/PaymentReconcile" },
);

export const AdminPaymentConfirmInput = Type.Object(
  { tradeNo: Type.Optional(Type.String()) },
  { $id: "#/components/schemas/AdminPaymentConfirmInput" },
);

export const AdminPaymentConfirmResult = Type.Object(
  {
    /** false 表示该订单此前已入账，本次未重复加积分。 */
    credited: Type.Boolean(),
    order: Type.Union([schemaRef(AdminPaymentOrder), Type.Null()]),
  },
  { $id: "#/components/schemas/AdminPaymentConfirmResult" },
);

// ---------------- 邮件（SMTP） ----------------

export const MailSettings = Type.Object(
  {
    configured: Type.Boolean(),
    host: Type.Union([Type.String(), Type.Null()]),
    port: Type.Integer(),
    secure: Type.Boolean(),
    requireStartTls: Type.Boolean(),
    user: Type.Union([Type.String(), Type.Null()]),
    from: Type.Union([Type.String(), Type.Null()]),
    fromName: Type.Union([Type.String(), Type.Null()]),
    /** 口令永不回显，只表示是否已配置。 */
    hasPass: Type.Boolean(),
  },
  { $id: "#/components/schemas/MailSettings" },
);

export const MailSettingsInput = Type.Object(
  {
    host: Type.Optional(Type.String()),
    port: Type.Optional(Type.Integer()),
    secure: Type.Optional(Type.Boolean()),
    requireStartTls: Type.Optional(Type.Boolean()),
    user: Type.Optional(Type.String()),
    /** 只在轮换口令时传；不传则保留原值。 */
    pass: Type.Optional(Type.String()),
    from: Type.Optional(Type.String()),
    fromName: Type.Optional(Type.String()),
  },
  { $id: "#/components/schemas/MailSettingsInput" },
);

export const MailSettingsUpdateResult = Type.Object(
  { ok: Type.Boolean(), hasPass: Type.Boolean() },
  { $id: "#/components/schemas/MailSettingsUpdateResult" },
);

export const MailTestResult = Type.Object({ ok: Type.Boolean() }, { $id: "#/components/schemas/MailTestResult" });
