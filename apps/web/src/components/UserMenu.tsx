import { Dropdown, type MenuProps } from "antd";
import { LayoutDashboard, LogOut, Wallet } from "lucide-react";
import { useNavigate } from "react-router";

import { useLogout, useSession } from "../api/hooks/useSession";
import { formatCredits } from "../api/session";
import styles from "./UserMenu.module.css";

/**
 * 顶栏用户菜单：展示当前身份与积分余额，提供退出。
 *
 * 会话未就绪或读取失败时整块不渲染——顶栏不能因为一次失败的会话查询就崩掉，
 * 也不能显示一个空的头像占位让人以为"账号丢了"。
 */
export function UserMenu() {
  const session = useSession();
  const logout = useLogout();
  const navigate = useNavigate();

  const user = session.data?.user;
  if (!user) return null;

  const handleLogout = async () => {
    await logout.mutateAsync();
    navigate("/login", { replace: true });
  };

  const items: MenuProps["items"] = [
    {
      key: "identity",
      disabled: true,
      label: (
        <div className={styles.identity}>
          <span className={styles.email}>{user.email}</span>
          <span className={styles.role}>{roleLabel(user.role)}</span>
        </div>
      ),
    },
    {
      key: "credits",
      disabled: true,
      icon: <Wallet size={14} strokeWidth={1.75} />,
      label: <span>余额 {formatCredits(session.data?.balanceMicrocredits)} 积分</span>,
    },
    { key: "billing", icon: <Wallet size={14} strokeWidth={1.75} />, label: "充值", onClick: () => navigate("/billing") },
    // 管理入口只对能进后台的角色出现：普通用户点了也只会看到 403，不如不显示。
    ...(user.role !== "user"
      ? [{ key: "admin", icon: <LayoutDashboard size={14} strokeWidth={1.75} />, label: "管理后台", onClick: () => navigate("/admin") }]
      : []),
    { type: "divider" },
    {
      key: "logout",
      danger: true,
      icon: <LogOut size={14} strokeWidth={1.75} />,
      label: "退出登录",
      onClick: () => void handleLogout(),
    },
  ];

  return (
    <Dropdown menu={{ items }} trigger={["click"]} placement="bottomRight">
      <button type="button" className={styles.trigger} aria-label="账号菜单">
        <span className={styles.avatar} aria-hidden>
          {user.displayName.slice(0, 1).toUpperCase()}
        </span>
        <span className={styles.name}>{user.displayName}</span>
      </button>
    </Dropdown>
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
