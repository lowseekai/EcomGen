/**
 * 生产配置守卫。
 *
 * 部署清单里写了"必须开 Secure Cookie、反代后必须设 TRUST_PROXY"，
 * 但清单靠人执行。这里把它们变成启动时的硬约束——配错就起不来，
 * 而不是悄悄带着一个弱配置跑起来。
 *
 * 只在 `ECOMGEN_PRODUCTION=true` 时生效，本地开发不受影响。
 */
export function assertProductionConfig(env: NodeJS.ProcessEnv): void {
  if (env.ECOMGEN_PRODUCTION !== "true") return;

  const problems: string[] = [];
  if (env.ECOMGEN_SECURE_COOKIES !== "true") {
    problems.push("ECOMGEN_SECURE_COOKIES 必须为 true（否则会话 Cookie 明文传输）");
  }
  if (!env.ECOMGEN_MASTER_KEY || env.ECOMGEN_MASTER_KEY.startsWith("replace-with")) {
    problems.push("ECOMGEN_MASTER_KEY 仍是占位值（Provider 密钥会以明文等价强度存储）");
  }
  if (problems.length > 0) {
    throw new Error(`生产配置不完整，拒绝启动：\n  - ${problems.join("\n  - ")}`);
  }

  // TRUST_PROXY 不阻断启动（直连部署本来就不该设），但必须让运维看见。
  if (!env.ECOMGEN_TRUST_PROXY) {
    console.warn("ECOMGEN_TRUST_PROXY 未设置：若前面有反向代理，所有用户会共享同一个限流桶。");
  }
}
