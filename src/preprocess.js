import sharp from "sharp";
import path from "path";
import fs from "fs/promises";

export async function preprocessImageForVlm(inputPath) {
  const tempDir = path.join(process.cwd(), "tmp", "processed");
  await fs.mkdir(tempDir, { recursive: true });

  const parsed = path.parse(inputPath);
  const outputPath = path.join(tempDir, `${parsed.name}_vlm.jpg`);

  await sharp(inputPath)
    .rotate()
    .resize({
      width: 1280,
      withoutEnlargement: true,
    })
    .jpeg({
      quality: 85,
    })
    .toFile(outputPath);

  return outputPath;
}