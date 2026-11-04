import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  adminApi,
  type AdminRole,
  type AdminUserStatus,
  type PriceRecord,
} from "../adminClient";

/**
 * 管理后台的查询与变更。
 *
 * 所有写操作成功后统一 invalidate 管理端相关查询：后台看到的数据必须立刻反映刚做的动作，
 * 否则管理员会重复点击（积分被加两次是最典型的后果）。
 */

export const adminKeys = {
  all: ["admin"] as const,
  users: (params: Record<string, unknown>) => ["admin", "users", params] as const,
  ledger: (userId: string) => ["admin", "ledger", userId] as const,
  uncertain: ["admin", "uncertain"] as const,
  prices: ["admin", "prices"] as const,
  payment: ["admin", "payment"] as const,
  mail: ["admin", "mail"] as const,
  audit: ["admin", "audit"] as const,
  dashboard: ["admin", "dashboard"] as const,
};

export function useAdminDashboard() {
  return useQuery({
    queryKey: adminKeys.dashboard,
    queryFn: () => adminApi.dashboard(),
    staleTime: 30_000,
  });
}

export function useAdminUsers(params: { keyword?: string; role?: string; status?: string; limit?: number; offset?: number }) {
  return useQuery({
    queryKey: adminKeys.users(params),
    queryFn: () => adminApi.listUsers(params),
    staleTime: 10_000,
  });
}

export function useAdminLedger(userId: string | null) {
  return useQuery({
    queryKey: adminKeys.ledger(userId ?? ""),
    queryFn: () => adminApi.ledger(userId!),
    enabled: Boolean(userId),
  });
}

export function useAdminUncertainOrders() {
  return useQuery({
    queryKey: adminKeys.uncertain,
    queryFn: () => adminApi.uncertainOrders({ limit: 100 }),
    staleTime: 10_000,
  });
}

export function usePaymentConfig() {
  return useQuery({
    queryKey: adminKeys.payment,
    queryFn: () => adminApi.paymentConfig(),
    staleTime: 10_000,
  });
}

export function useUpdatePaymentConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof adminApi.updatePaymentConfig>[0]) => adminApi.updatePaymentConfig(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
  });
}

export function useMailSettings() {
  return useQuery({
    queryKey: adminKeys.mail,
    queryFn: () => adminApi.mailSettings(),
    staleTime: 10_000,
  });
}

export function useUpdateMailSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof adminApi.updateMailSettings>[0]) => adminApi.updateMailSettings(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
  });
}

export function useTestMailSettings() {
  return useMutation({ mutationFn: () => adminApi.testMailSettings() });
}

export function useAdminPrices() {
  return useQuery({
    queryKey: adminKeys.prices,
    queryFn: () => adminApi.listPrices(),
    staleTime: 10_000,
  });
}

export function useAdminAudit() {
  return useQuery({
    queryKey: adminKeys.audit,
    queryFn: () => adminApi.audit({ limit: 100 }),
    staleTime: 10_000,
  });
}

export function usePatchAdminUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: { displayName?: string; role?: AdminRole; status?: AdminUserStatus } }) =>
      adminApi.patchUser(userId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
  });
}

export function useAdjustCredits() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, credits, note }: { userId: string; credits: number; note?: string }) =>
      adminApi.adjustCredits(userId, { credits, note }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
  });
}

export function useCreateAdminUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof adminApi.createUser>[0]) => adminApi.createUser(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
  });
}

export function useResetUserPassword() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, password }: { userId: string; password?: string }) => adminApi.resetPassword(userId, { password }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
  });
}

export function useResolveOrder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ jobId, action, settledMicrocredits, note }: { jobId: string; action: "settle" | "refund"; settledMicrocredits?: number; note?: string }) =>
      adminApi.resolveOrder(jobId, { action, settledMicrocredits, note }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.all });
    },
  });
}

export function useUpsertPrice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: Parameters<typeof adminApi.upsertPrice>[0]) => adminApi.upsertPrice(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.prices });
    },
  });
}

export function useDeletePrice() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (price: PriceRecord) => adminApi.deletePrice(price.id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: adminKeys.prices });
    },
  });
}
