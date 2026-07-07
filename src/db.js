import mongoose from "mongoose";

const PhoneSchema = new mongoose.Schema(
  {},
  {
    strict: false,
    collection: "phones",
  }
);

export const Phone = mongoose.model("Phone", PhoneSchema);

const DeviceConfigSchema = new mongoose.Schema(
  {},
  {
    strict: false,
    collection: "deviceconfigs",
  }
);

export const DeviceConfig = mongoose.model("DeviceConfig", DeviceConfigSchema);


export async function connectDb() {
  const uri = process.env.MONGODB_URI;

  if (!uri) {
    throw new Error("Missing MONGODB_URI in .env");
  }

  mongoose.set("strictQuery", true);

  await mongoose.connect(uri, {
    serverSelectionTimeoutMS: 10000,
  });

  console.log("✅ MongoDB connected");
}

export async function findDeviceConfigByDeviceId(deviceId) {
  if (!deviceId) return null;

  return DeviceConfig.findOne({ deviceId })
    .select({
      deviceId: 1,
      vlmPromptOverride: 1,
    })
    .lean();
}

export async function findPhonesWithUnprocessedImages({ limit = 5 } = {}) {
  return Phone.find({
    "lastImage.object": { $exists: true, $ne: null },
    $or: [
      { aiLastProcessedImageObject: { $exists: false } },
      { aiLastProcessedImageObject: null },
      {
        $expr: {
          $ne: ["$lastImage.object", "$aiLastProcessedImageObject"],
        },
      },
    ],
  })
    .sort({ lastUploadAt: -1 })
    .limit(limit)
    .lean();
}


export async function savePhoneAiResult({
  phoneId,
  deviceId,
  imageObject,
  parsedResult,
  model,
  processedImagePath,
}) {
  if (!phoneId) {
    throw new Error("savePhoneAiResult missing phoneId");
  }

  const now = new Date();

  const update = {
    aiLastProcessedImageObject: imageObject,
    aiLastProcessedAt: now,
    aiLastResult: {
      status: parsedResult.status,
      vacancy: parsedResult.vacancy,
      rawText: parsedResult.rawText,
      error: parsedResult.error || null,
      model,
      processedAt: now,
      processedImagePath,
    },
  };

  const updated = await Phone.findOneAndUpdate(
    {
      _id: phoneId,
      deviceId,
    },
    { $set: update },
    {
      returnDocument: "after",
    }
  ).lean();

  if (!updated) {
    throw new Error(
      `Phone not found when saving AI result. phoneId=${phoneId}, deviceId=${deviceId}`
    );
  }

  return updated;
}

