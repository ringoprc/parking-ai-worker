export function parseLmStudioVacancyResult(rawText) {
  if (!rawText || typeof rawText !== "string") {
    return {
      status: "error",
      vacancy: null,
      error: "Empty LM Studio response",
      rawText,
    };
  }

  const cleaned = rawText
    .trim()
    .replace(/^```json/i, "")
    .replace(/^```/i, "")
    .replace(/```$/i, "")
    .trim();

  const jsonMatch = cleaned.match(/\{[\s\S]*\}/);

  if (!jsonMatch) {
    return {
      status: "error",
      vacancy: null,
      error: "No JSON object found",
      rawText,
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]);

    if (parsed.status === "unknown") {
      return {
        status: "unknown",
        vacancy: null,
        rawText,
      };
    }

    if (parsed.status !== "ok") {
      return {
        status: "error",
        vacancy: null,
        error: `Invalid status: ${parsed.status}`,
        rawText,
      };
    }

    const vacancy = Number(parsed.vacancy);

    if (!Number.isInteger(vacancy) || vacancy < 0 || vacancy > 9999) {
      return {
        status: "error",
        vacancy: null,
        error: `Invalid vacancy: ${parsed.vacancy}`,
        rawText,
      };
    }

    return {
      status: "ok",
      vacancy,
      rawText,
    };
  } catch (err) {
    return {
      status: "error",
      vacancy: null,
      error: err.message,
      rawText,
    };
  }
}


