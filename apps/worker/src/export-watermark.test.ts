import { describe, expect, it } from "vitest";
import sharp from "sharp";

import { watermarkImage } from "./job-export.js";

/**
 * 导出水印。
 *
 * `watermarkExports` 曾经是唯一一个"配了完全没作用"的权益——导出直接把原图塞进 ZIP。
 * 这里验证合成真的发生、格式没被改坏、以及坏输入不会让整包导出失败。
 */

async function solidPng(width: number, height: number): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: { r: 20, g: 120, b: 200 } } }).png().toBuffer();
}

describe("导出水印", () => {
  it("叠加水印后图片仍是有效 PNG，且内容发生变化", async () => {
    const original = await solidPng(320, 200);
    const watermarked = await watermarkImage(original, "仅供预览");

    expect(watermarked.length).toBeGreaterThan(0);
    const metadata = await sharp(watermarked).metadata();
    expect(metadata.format).toBe("png");
    expect(metadata.width).toBe(320);
    expect(metadata.height).toBe(200);
    // 纯色图加水印后不可能和原图字节一致。
    expect(Buffer.compare(watermarked, original)).not.toBe(0);
  });

  it("文字里的 XML 特殊字符不会让合成失败", async () => {
    const original = await solidPng(200, 200);
    const watermarked = await watermarkImage(original, "A & B <tag>");
    const metadata = await sharp(watermarked).metadata();
    expect(metadata.format).toBe("png");
  });

  it("非图片内容原样返回，不抛错", async () => {
    const text = Buffer.from("{\"manifest\":true}", "utf8");
    await expect(watermarkImage(text, "仅供预览")).resolves.toBe(text);
  });

  it("损坏的图片原样返回（单张失败不能拖垮整包导出）", async () => {
    const broken = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]);
    await expect(watermarkImage(broken, "仅供预览")).resolves.toBe(broken);
  });
});
