import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { billingApi } from "../billingClient";

export const billingKeys = {
  all: ["billing"] as const,
  orders: ["billing", "orders"] as const,
  order: (orderId: string) => ["billing", "order", orderId] as const,
};

export function useBillingOrders() {
  return useQuery({
    queryKey: billingKeys.orders,
    queryFn: () => billingApi.listOrders({ limit: 50 }),
    staleTime: 10_000,
  });
}

/**
 * 回跳页用：轮询单号状态。
 *
 * 网关回调是异步的，用户从收银台跳回来时订单往往还是 pending。
 * 每 2 秒查一次、最多约 1 分钟，避免用户以为"付了钱但没到账"。
 */
export function usePaymentOrder(orderId: string | null) {
  return useQuery({
    queryKey: billingKeys.order(orderId ?? ""),
    queryFn: () => billingApi.getOrder(orderId!),
    enabled: Boolean(orderId),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "paid" || status === "failed" || status === "closed") return false;
      return 2000;
    },
  });
}

export function useCreateTopup() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (credits: number) => billingApi.createTopup(credits),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: billingKeys.all });
    },
  });
}
