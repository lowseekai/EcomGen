import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { fetchSession, login, logout, register, type SessionPayload } from "../session";

export const SESSION_QUERY_KEY = ["session"] as const;

/**
 * 当前会话。全站唯一的登录态来源。
 *
 * `/auth/me` 未登录时返回 `{ user: null }` 而不是 401，所以这里不需要把 401 当特殊情况处理，
 * `data.user === null` 就是"未登录"。
 */
export function useSession() {
  return useQuery({
    queryKey: SESSION_QUERY_KEY,
    queryFn: fetchSession,
    staleTime: 60_000,
    // 会话状态是路由守卫的依据，重试会拖长"白屏"时间，直接失败更快暴露问题。
    retry: false,
  });
}

export function useLogin() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string }) => login(input),
    onSuccess: (payload) => queryClient.setQueryData<SessionPayload>(SESSION_QUERY_KEY, payload),
  });
}

export function useRegister() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { email: string; password: string; displayName?: string }) => register(input),
    onSuccess: (payload) => queryClient.setQueryData<SessionPayload>(SESSION_QUERY_KEY, payload),
  });
}

export function useLogout() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => logout(),
    // 无论服务端是否成功，本地都必须清空登录态：否则用户会卡在"看着像登录了但所有请求 401"。
    onSettled: () => queryClient.setQueryData<SessionPayload>(SESSION_QUERY_KEY, { user: null }),
  });
}
