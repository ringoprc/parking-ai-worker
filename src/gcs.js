import { Storage } from "@google-cloud/storage";
import fs from "fs/promises";
import path from "path";

const storage = new Storage();

export async function downloadGcsObjectToTemp(objectName, options = {}) {
  const bucketName =
    String(options.bucketName || "").trim() ||
    String(process.env.GCS_BUCKET_NAME || "").trim() ||
    String(process.env.GCS_BUCKET || "").trim();

  if (!bucketName) {
    throw new Error("Missing bucketName, GCS_BUCKET_NAME, or GCS_BUCKET");
  }

  if (!objectName) {
    throw new Error("Missing objectName");
  }

  const tempDir = path.join(process.cwd(), "tmp");
  await fs.mkdir(tempDir, { recursive: true });

  const safeName = objectName.replace(/[\/\\]/g, "_");
  const localPath = path.join(tempDir, safeName);

  console.log(`⬇️ Downloading gs://${bucketName}/${objectName}`);
  await storage.bucket(bucketName).file(objectName).download({
    destination: localPath,
  });

  console.log(`✅ Downloaded to ${localPath}`);
  return localPath;
}