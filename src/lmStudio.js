import axios from "axios";
import fs from "fs/promises";

export async function readVacancyWithLmStudio(imagePath, options = {}) {
  const baseUrl = process.env.LM_STUDIO_BASE_URL || "http://localhost:1234/v1";
  const model = process.env.LM_STUDIO_MODEL;

  if (!model) {
    throw new Error("Missing LM_STUDIO_MODEL in .env");
  }

  const imageBuffer = await fs.readFile(imagePath);
  const base64Image = imageBuffer.toString("base64");

  const prompt = String(options?.prompt ?? "").trim();

  if (!prompt) {
    throw new Error("Missing VLM prompt from backend job");
  }

  const res = await axios.post(
    `${baseUrl}/chat/completions`,
    {
      model,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text: prompt,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/jpeg;base64,${base64Image}`,
              },
            },
          ],
        },
      ],
    },
    {
      timeout: 120000,
    }
  );

  const text = res.data?.choices?.[0]?.message?.content;

  return {
    raw: text,
  };
}



