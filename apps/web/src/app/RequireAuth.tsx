import { Button, Result, Spin } from "antd";
import type { ReactNode } from "react";
import { Navigate, Outlet, useLocation } from "react-router";

import { useSession } from "../api/hooks/useSession";
import styles from "../features/auth/auth.module.css";

/**
 * 登录守卫。
 *
 * 未登录时带上原目标路径跳转，登录后由 AuthPage 读回，避免用户被一律丢回首页。
 * 会话查询失败（网络/服务不可用）时给重试入口，而不是渲染成"未登录"——
 * 把故障伪装成未登录会让用户反复输密码，问题却不在密码上。
 */
export function RequireAuth({ children }: { children?: ReactNode }) {
  const session = useSession();
  const location = useLocation();

  if (session.isPending) {
    return (
      <div className={styles.centered}>
        <Spin />
        <span>正在读取登录状态…</span>
      </div>
    );
  }

  if (session.isError) {
    return (
      <div className={styles.centered}>
        <Result
          status="warning"
          title="无法连接服务"
          subTitle="请检查后端服务是否已启动，然后重试。"
          extra={<Button onClick={() => void session.refetch()}>重试</Button>}
        />
      </div>
    );
  }

  if (!session.data?.user) {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }

  return <>{children ?? <Outlet />}</>;
}
