import archiver from "archiver";
import sharp from "sharp";
import type { JobRecord, ProjectRecord } from "@ecomgen/core";
import type { WorkerContext } from "./context.js";
import { safeName } from "./context.js";

export async function executeExport(ctx: WorkerContext, job: JobRecord): Promise<void> {
  const { repository, storage, events, updateJob, throwIfCancelled, projectFor } = ctx;
  throwIfCancelled(job);
  const project = projectFor(job); const outputIds = Array.isArray(job.input.outputIds) ? job.input.outputIds.filter((value): value is string => typeof value === "string") : undefined;
  const outputs = repository.listOutputs(project.id).filter((output) => !outputIds || outputIds.includes(output.id)); if (outputs.length === 0) throw new Error("No outputs are available for export");
  const exportRecord = repository.getExportByJobId(job.id); await updateJob(job, { progress: 25 });
  // manifest 让导出包可追溯到事实、模板、Prompt、审核结果和输出内容 hash。
  const manifest = { version: 1, generatedAt: new Date().toISOString(), project: { id: project.id, name: project.name, platforms: project.platformTargets, category: project.category, imageResolution: project.imageResolution, imageAspectRatio: project.imageAspectRatio }, facts: { verified: project.verifiedFacts, prohibited: project.prohibitedClaims, brandGuidelines: project.brandGuidelines }, storyboard: outputs.map((output) => { const item = repository.getStoryboardItem(output.storyboardItemId); return { outputId: output.id, jobId: output.jobId, assetType: item?.assetType ?? null, displayName: item?.displayName ?? null, templateVariant: item?.templateVariant ?? null, mode: item?.mode ?? null, candidateIndex: output.candidateIndex, generationSnapshot: output.generationSnapshot, prompt: item?.compiledPrompt ?? null, sha256: output.hash }; }) };
  // 流式导出：图片从磁盘直接进 archiver 管道，内存峰值从"全部图片 + 整个 ZIP"降为常数级；
  // zlib level 1——产物是已压缩的 PNG/JPEG，level 9 几乎无压缩收益，纯耗 CPU。
  // 水印由套餐决定：免费套餐加水印、付费套餐给原图，这是付费墙的一部分。
  // 文案走设置项，方便运营调整而不用改代码。
  const watermarkText = shouldWatermarkExport(ctx, job) ? ctx.repository.getSetting("export_watermark_text", "仅供预览") : null;
  const stored = await storage.putExportStream(project.id, async (destination) => {
    const zip = archiver("zip", { zlib: { level: 1 } });
    const settled = new Promise<void>((resolve, reject) => {
      destination.once("close", () => resolve());
      destination.once("error", reject);
      zip.once("error", reject);
    });
    zip.pipe(destination);
    // 逐张处理：水印需要解码整张图，一次性并发会把内存打满。
    for (const [index, output] of outputs.entries()) {
      const name = exportFileName(ctx, project, output, index);
      if (!watermarkText) { zip.file(storage.absolute(output.storagePath), { name }); continue; }
      zip.append(await watermarkImage(await storage.read(output.storagePath), watermarkText), { name });
    }
    zip.append(Buffer.from(JSON.stringify(manifest, null, 2), "utf8"), { name: "manifest.json" });
    await zip.finalize();
    await settled;
  });
  const target = exportRecord ?? repository.createExport({ projectId: project.id, jobId: job.id, status: "QUEUED", storagePath: null }); const updated = repository.updateExport(target.id, { status: "SUCCEEDED", storagePath: stored.path }); await events.publish(project.id, "export.updated", { export: updated });
}

/** 该任务的所有者是否属于"导出加水印"的套餐。查不到用户时按加水印处理（宁可保守）。 */
function shouldWatermarkExport(ctx: WorkerContext, job: JobRecord): boolean {
  if (!job.ownerId) return false;
  const owner = ctx.repository.getUser(job.ownerId);
  if (!owner) return false;
  return ctx.repository.resolveEntitlements(owner).entitlements.watermarkExports;
}

/**
 * 在右下角叠加半透明文字水印。
 *
 * 保留原格式（`toBuffer()` 默认沿用输入格式）：转成 PNG 会让文件名里的扩展名与实际内容不符。
 * 非图片直接原样返回，避免把 manifest 之类的文件也拖进解码流程。
 */
export async function watermarkImage(content: Buffer, text: string): Promise<Buffer> {
  try {
    const image = sharp(content);
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height || !metadata.format) return content;
    const fontSize = Math.max(14, Math.round(Math.min(metadata.width, metadata.height) * 0.045));
    // 文字进 SVG 前必须转义，否则 & 或 < 会让整段标记失效。
    const escaped = text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
    const svg = `<svg width="${metadata.width}" height="${metadata.height}" xmlns="http://www.w3.org/2000/svg">
      <text x="${Math.round(metadata.width * 0.97)}" y="${Math.round(metadata.height * 0.95)}"
        font-family="sans-serif" font-size="${fontSize}" fill="rgba(255,255,255,0.75)"
        stroke="rgba(0,0,0,0.35)" stroke-width="1" text-anchor="end">${escaped}</text>
    </svg>`;
    return await image.composite([{ input: Buffer.from(svg) }]).toBuffer();
  } catch {
    // 单张图加水印失败不应该让整包导出失败——退回原图并继续。
    return content;
  }
}

function exportFileName(ctx: WorkerContext, project: ProjectRecord, output: { storyboardItemId: string; storagePath: string }, index: number): string { const item = ctx.repository.getStoryboardItem(output.storyboardItemId); const extension = output.storagePath.slice(output.storagePath.lastIndexOf(".")); return `${safeName(project.name)}_${String(index + 1).padStart(2, "0")}_${safeName(item?.assetType ?? "image")}${extension}`; }
