import { Type } from "@sinclair/typebox";

import { schemaRef } from "./ref.js";
import { AdminRole, AdminUserStatus, Entitlements } from "./admin-schemas.js";

/**
 * 认证契约。
 *
 * 会话用 httpOnly Cookie，响应体里**不出现 token**——token 只存在于 `Set-Cookie`。
 * 前端通过 `credentials: "include"` 自动携带，拿不到也不需要拿到。
 */

export const SessionUser = Type.Object(
  {
    id: Type.String({ format: "uuid" }),
    email: Type.String(),
    displayName: Type.String(),
    role: schemaRef(AdminRole),
    status: schemaRef(AdminUserStatus),
    createdAt: Type.String({ format: "date-time" }),
  },
  { $id: "#/components/schemas/SessionUser" },
);

export const SessionPayload = Type.Object(
  {
    user: schemaRef(SessionUser),
    planCode: Type.String(),
    entitlements: schemaRef(Entitlements),
    balanceMicrocredits: Type.Integer(),
    usedStorageBytes: Type.Integer(),
  },
  { $id: "#/components/schemas/SessionPayload" },
);

/**
 * `/auth/me` 的响应。
 *
 * 未登录返回 `{ user: null }` 而不是 401：前端启动时无条件调用它判断状态，
 * 用 401 会让"未登录"和"网络故障"混在一起。
 */
export const SessionState = Type.Union(
  [schemaRef(SessionPayload), Type.Object({ user: Type.Null() })],
  { $id: "#/components/schemas/SessionState" },
);

export const RegisterInput = Type.Object(
  {
    email: Type.String(),
    password: Type.String(),
    displayName: Type.Optional(Type.String()),
  },
  { $id: "#/components/schemas/RegisterInput" },
);

export const LoginInput = Type.Object(
  {
    email: Type.String(),
    password: Type.String(),
  },
  { $id: "#/components/schemas/LoginInput" },
);

export const PasswordResetRequestInput = Type.Object(
  { email: Type.String() },
  { $id: "#/components/schemas/PasswordResetRequestInput" },
);

export const PasswordResetRequestResult = Type.Object(
  {
    /** 无论邮箱是否存在都返回 accepted，避免接口变成账号枚举器。 */
    accepted: Type.Literal(true),
    /** 仅在 `password_reset_expose_token` 打开时返回，供内测环境手工取令。 */
    token: Type.Optional(Type.String()),
    expiresAt: Type.Optional(Type.String({ format: "date-time" })),
  },
  { $id: "#/components/schemas/PasswordResetRequestResult" },
);

export const PasswordResetConfirmInput = Type.Object(
  {
    token: Type.String(),
    password: Type.String(),
  },
  { $id: "#/components/schemas/PasswordResetConfirmInput" },
);

export const ChangePasswordInput = Type.Object(
  {
    currentPassword: Type.String(),
    newPassword: Type.String(),
  },
  { $id: "#/components/schemas/ChangePasswordInput" },
);
