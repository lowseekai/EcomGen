import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  GeminiImageProvider,
  OpenAiCompatibleImageProvider,
  ProviderError,
  SeedreamLayerizeProvider,
  createSegmentationProvider,
  probeReasoning,
  type PromptSegmentationProtocol,
} from "@ecomgen/providers";
import type { ProviderRecord, UserRecord } from "@ecomgen/core";
import { CreateProviderInput, TestProviderInput, UpdateProviderInput } from "@ecomgen/contracts";
import type { ReasoningProtocolProfile } from "@ecomgen/contracts";
import { requireRole } from "../auth-guard.js";
import type { ApiContext } from "../context.js";
import { ApiError } from "../errors.js";
import { missing } from "../helpers.js";
import { parseBody } from "../http-input.js";
import { enumValue, normalizeModels, parameter, readOptionalText, readText } from "../input-normalizers.js";

function publicProvider(value: ProviderRecord): object { const { encryptedApiKey, ...provider } = value; return { ...provider, hasApiKey: Boolean(encryptedApiKey) }; }

/**
 * 平台代付：Provider 由管理员统一配置、API Key 由平台持有，普通用户只读。
 *
 * 写操作必须挡住，否则任何一个注册用户都能改掉全平台的渠道配置——删除 Provider 会级联
 * 把所有人的项目模型引用置空、并把在途任务取消，这是跨租户的破坏性操作。
 * 连通性测试同样要挡：它用平台的 Key 打上游，普通用户可以把平台当探测代理用。
 */
function adminOnly(request: FastifyRequest): UserRecord {
  return requireRole(request, ["owner", "admin"]);
}

export function registerProviderRoutes(app: FastifyInstance, ctx: ApiContext): void {
  const { repository, secrets, events } = ctx;
  // 读保留给所有登录用户：前端选模型、显示能力摘要都要它。密钥字段已由 publicProvider 剥掉。
  app.get("/api/v1/providers", async () => ({ items: repository.listProviders().map(publicProvider), nextCursor: null }));
  app.post("/api/v1/providers", async (request, reply) => {
    const actor = adminOnly(request);
    const body = parseBody(CreateProviderInput, request.body);
    const models = normalizeModels(body.models);
    const apiKey = readText(body.apiKey, "apiKey");
    const reasoningProtocol = enumValue<ReasoningProtocolProfile>(body.reasoningProtocol ?? "openai", ["openai", "dashscope_qwen", "openai_responses"], "reasoningProtocol");
    const record = repository.saveProvider({ name: readText(body.name, "name"), baseUrl: readText(body.baseUrl, "baseUrl"), reasoningProtocol, encryptedApiKey: secrets.encrypt(apiKey), models });
    // 审计只记可读元数据：密钥永远不进审计表。
    repository.recordAuditEvent({ actorUserId: actor.id, action: "provider.create", targetType: "provider", targetId: record.id, summary: `新增平台渠道 ${record.name}`, data: { baseUrl: record.baseUrl, models: models.map((model) => model.id) } });
    await events.publish("system", "provider.updated", publicProvider(record)); return reply.code(201).send(publicProvider(record));
  });
  app.patch("/api/v1/providers/:providerId", async (request) => {
    const actor = adminOnly(request);
    const id = parameter(request, "providerId"); const current = repository.getProvider(id); if (!current) missing("provider", id);
    const body = parseBody(UpdateProviderInput, request.body);
    const reasoningProtocol = body.reasoningProtocol === undefined ? current.reasoningProtocol : enumValue<ReasoningProtocolProfile>(body.reasoningProtocol, ["openai", "dashscope_qwen", "openai_responses"], "reasoningProtocol");
    const record = repository.saveProvider({ id, name: readOptionalText(body.name) ?? current.name, baseUrl: readOptionalText(body.baseUrl) ?? current.baseUrl, reasoningProtocol, encryptedApiKey: body.apiKey ? secrets.encrypt(readText(body.apiKey, "apiKey")) : current.encryptedApiKey, models: body.models ? normalizeModels(body.models) : current.models });
    repository.recordAuditEvent({ actorUserId: actor.id, action: "provider.update", targetType: "provider", targetId: id, summary: `修改平台渠道 ${record.name}`, data: { baseUrl: record.baseUrl, apiKeyRotated: Boolean(body.apiKey), models: record.models.map((model) => model.id) } });
    await events.publish("system", "provider.updated", publicProvider(record)); return publicProvider(record);
  });
  app.post("/api/v1/providers/:providerId/test", async (request) => {
    adminOnly(request);
    const providerId = parameter(request, "providerId"); const provider = repository.getProvider(providerId); if (!provider) missing("provider", providerId);
    const body = parseBody(TestProviderInput, request.body); const modelId = readText(body.modelId, "modelId"); const kind = enumValue<"reasoning" | "image" | "segmentation">(body.kind ?? "image", ["reasoning", "image", "segmentation"], "kind");
    const model = provider.models.find((candidate) => candidate.id === modelId); if (!model) throw new ApiError(400, "VALIDATION_ERROR", "modelId is not declared by the selected provider");
    if (kind === "image" && !model.imageApiKind) throw new ApiError(422, "CAPABILITY_UNSUPPORTED", "Selected image model has no image API configured");
    if (kind === "segmentation" && !model.segmentationProtocol) throw new ApiError(422, "CAPABILITY_UNSUPPORTED", "Selected segmentation model has no segmentation API configured");
    try {
      if (kind === "reasoning") {
        const probeModel = model;
        const probe = await probeReasoning({ providerId, modelId, baseUrl: provider.baseUrl, protocol: provider.reasoningProtocol, supportsVision: probeModel.supportsVision, supportsThinking: probeModel.supportsThinking, supportsStructuredOutput: probeModel.supportsStructuredOutput, apiKey: secrets.decrypt(provider.encryptedApiKey) });
        return { ok: true, providerId, modelId, kind, latencyMs: probe.latencyMs, models: null, modelAvailable: true };
      }
      if (kind === "segmentation") {
        // 分割探测只做零费用连通性检查（/models 或最小请求），不调用真实分割
        const apiKey = secrets.decrypt(provider.encryptedApiKey);
        // seedream 走整图图层合成协议（无逐元素接口），其余文本提示协议统一由工厂选择适配器
        const probe = model.segmentationProtocol === "seedream_layerize"
          ? await new SeedreamLayerizeProvider({ baseUrl: provider.baseUrl, apiKey }).probe()
          : await createSegmentationProvider(model.segmentationProtocol as PromptSegmentationProtocol, { baseUrl: provider.baseUrl, apiKey }).probe();
        return { ok: true, providerId, modelId, kind, ...probe, modelAvailable: null };
      }
      const probe = model.imageApiKind === "gemini"
        ? await new GeminiImageProvider({ baseUrl: provider.baseUrl, apiKey: secrets.decrypt(provider.encryptedApiKey) }).probe()
        : await new OpenAiCompatibleImageProvider({ baseUrl: provider.baseUrl, apiKey: secrets.decrypt(provider.encryptedApiKey) }).probe();
      return { ok: true, providerId, modelId, kind, ...probe, modelAvailable: probe.models === null ? null : probe.models.includes(modelId) };
    }
    catch (error) { if (error instanceof ProviderError) throw new ApiError(502, "PROVIDER_ERROR", error.message); throw error; }
  });
  app.delete("/api/v1/providers/:providerId", async (request, reply) => {
    const actor = adminOnly(request);
    const id = parameter(request, "providerId");
    const current = repository.getProvider(id);
    const result = repository.deleteProvider(id); if (result === "missing") missing("provider", id);
    // 删除是跨租户破坏性操作（级联置空所有人项目里的模型引用、取消在途任务），必须留痕。
    repository.recordAuditEvent({ actorUserId: actor.id, action: "provider.delete", targetType: "provider", targetId: id, summary: `删除平台渠道 ${current?.name ?? id}`, data: {} });
    return reply.code(204).send();
  });
}
