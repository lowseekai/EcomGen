import { Alert, Button, Form, Input } from "antd";
import { Link, useLocation, useNavigate } from "react-router";

import { isApiError } from "../../api/errors";
import { useLogin, useRegister } from "../../api/hooks/useSession";
import styles from "./auth.module.css";

interface AuthFormValues {
  email: string;
  password: string;
  confirmPassword?: string;
  displayName?: string;
}

const MIN_PASSWORD_LENGTH = 8;

/**
 * 登录 / 注册页。
 *
 * 两种模式共用一套版式，只在字段与文案上分叉——两个页面各写一份表单必然在
 * 校验规则、错误提示、跳转逻辑上漂移。
 */
export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const navigate = useNavigate();
  const location = useLocation();
  const login = useLogin();
  const register = useRegister();
  const isLogin = mode === "login";
  const pending = login.isPending || register.isPending;
  const error = login.error ?? register.error;

  // 守卫跳转前记录的目标路径，登录成功后回到原处，而不是一律回首页。
  const from = (location.state as { from?: string } | null)?.from ?? "/";

  const handleFinish = async (values: AuthFormValues) => {
    try {
      if (isLogin) {
        await login.mutateAsync({ email: values.email.trim(), password: values.password });
      } else {
        await register.mutateAsync({
          email: values.email.trim(),
          password: values.password,
          displayName: values.displayName?.trim() || undefined,
        });
      }
      void navigate(from, { replace: true });
    } catch {
      // 错误由 mutation.error 统一渲染；这里只是阻止未捕获的 rejection。
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.card}>
        <div className={styles.brand}>
          <span className={styles.brandName}>EcomGen</span>
          <span className={styles.brandTag}>Workbench</span>
        </div>

        <h1 className={styles.headline}>{isLogin ? "登录工作台" : "创建账号"}</h1>
        <p className={styles.lede}>
          {isLogin ? "使用邮箱和密码登录，继续你的商品套图项目。" : "注册后即可创建项目并生成整套电商图片。"}
        </p>

        {error ? <Alert type="error" showIcon message={errorMessage(error)} style={{ marginBottom: 18 }} /> : null}

        <Form<AuthFormValues> layout="vertical" requiredMark={false} onFinish={handleFinish} className={styles.form} disabled={pending}>
          <Form.Item
            name="email"
            label="邮箱"
            rules={[
              { required: true, message: "请填写邮箱" },
              { type: "email", message: "邮箱格式不正确" },
            ]}
          >
            <Input autoComplete="email" placeholder="you@example.com" autoFocus />
          </Form.Item>

          {isLogin ? null : (
            <Form.Item name="displayName" label="昵称" rules={[{ max: 64, message: "昵称最多 64 个字符" }]}>
              <Input autoComplete="nickname" placeholder="可留空，默认取邮箱前缀" />
            </Form.Item>
          )}

          <Form.Item
            name="password"
            label="密码"
            rules={[
              { required: true, message: "请填写密码" },
              { min: MIN_PASSWORD_LENGTH, message: `密码至少 ${MIN_PASSWORD_LENGTH} 位` },
            ]}
          >
            <Input.Password autoComplete={isLogin ? "current-password" : "new-password"} placeholder={`至少 ${MIN_PASSWORD_LENGTH} 位`} />
          </Form.Item>

          {isLogin ? null : (
            <Form.Item
              name="confirmPassword"
              label="确认密码"
              dependencies={["password"]}
              rules={[
                { required: true, message: "请再次填写密码" },
                ({ getFieldValue }) => ({
                  validator(_, value) {
                    if (!value || getFieldValue("password") === value) return Promise.resolve();
                    return Promise.reject(new Error("两次输入的密码不一致"));
                  },
                }),
              ]}
            >
              <Input.Password autoComplete="new-password" placeholder="再输入一次" />
            </Form.Item>
          )}

          <Button type="primary" htmlType="submit" block loading={pending} className={styles.submit}>
            {isLogin ? "登录" : "注册并开始"}
          </Button>
        </Form>

        <div className={styles.footer}>
          {isLogin ? (
            <>
              还没有账号？<Link className={styles.link} to="/register">注册</Link>
            </>
          ) : (
            <>
              已有账号？<Link className={styles.link} to="/login">登录</Link>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 把后端错误码翻译成可执行的提示，而不是把原始 message 直接丢给用户。 */
function errorMessage(error: unknown): string {
  if (!isApiError(error)) return "网络异常，请稍后重试";
  switch (error.code) {
    case "RATE_LIMITED":
      return error.message;
    case "UNAUTHORIZED":
      return "邮箱或密码不正确";
    case "FORBIDDEN":
      // 注册关闭与账号禁用都走 FORBIDDEN，用后端文案区分更准确。
      return error.message;
    case "CONFLICT":
      return "该邮箱已注册，请直接登录";
    case "VALIDATION_ERROR":
      return error.message;
    default:
      return error.message || "操作失败，请稍后重试";
  }
}
