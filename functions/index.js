/**
 * Kutla – Firebase Cloud Functions (güvenli proxy)
 * API key'leri asla istemciye gönderilmez; tüm çağrılar sunucuda yapılır.
 *
 * Genel proxy (isteğe bağlı kullanım):
 *   callOpenAI  – { model?, messages } → { message, usage? }
 *   callReplicate – { model, input } → { output }
 *
 * Kutla iOS uygulamasıyla uyumlu callable'lar:
 *   generateImagePrompt – { eventName, eventType, isLandscape } → { prompt }
 *   generateImage       – { prompt, size?, provider } → { imageUrl }
 *   generateMessage     – { eventName, tone, companyName? } → { message }
 *
 * Kurulum:
 * 1. firebase login
 * 2. functions/.env.<projectId> içinde OPENAI_API_KEY ve REPLICATE_API_TOKEN
 * 3. firebase deploy --only functions
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const OpenAI = require("openai").default;
const Replicate = require("replicate");

const openAiKey = defineString("OPENAI_API_KEY");
const replicateToken = defineString("REPLICATE_API_TOKEN");

function getOpenAIClient() {
  const key = openAiKey.value();
  if (!key) {
    throw new HttpsError(
      "failed-precondition",
      "OPENAI_API_KEY tanımlı değil. functions/.env.<projectId> dosyasına ekleyin."
    );
  }
  return new OpenAI({ apiKey: key });
}

function getReplicateClient() {
  const token = replicateToken.value();
  if (!token) {
    throw new HttpsError(
      "failed-precondition",
      "REPLICATE_API_TOKEN tanımlı değil. functions/.env.<projectId> dosyasına ekleyin."
    );
  }
  return new Replicate({ auth: token });
}

/**
 * OpenAI çağrısı (sunucuda). İstemci sadece isteği ve sonucu görür, key görmez.
 * data: { model?, messages } — messages OpenAI formatında (role + content).
 */
exports.callOpenAI = onCall(async (request) => {
  const data = request.data;
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "data gerekli (object).");
  }
  const { model = "gpt-4o-mini", messages } = data;
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new HttpsError("invalid-argument", "messages gerekli (boş olmayan dizi).");
  }

  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: String(model),
    messages: messages.map((m) => ({
      role: m.role || "user",
      content: m.content,
    })),
  });

  const choice = completion.choices?.[0];
  if (!choice) {
    throw new HttpsError("internal", "OpenAI yanıtı boş.");
  }
  return {
    message: {
      role: choice.message?.role ?? "assistant",
      content: choice.message?.content ?? null,
    },
    usage: completion.usage ? {
      prompt_tokens: completion.usage.prompt_tokens,
      completion_tokens: completion.usage.completion_tokens,
      total_tokens: completion.usage.total_tokens,
    } : undefined,
  };
});

/**
 * Replicate model çalıştırma (sunucuda). İstemci sadece model + input ve çıktıyı görür, token görmez.
 * data: { model, input } — model örn. "stability-ai/sdxl:...", input model'e göre.
 */
exports.callReplicate = onCall(async (request) => {
  const data = request.data;
  if (!data || typeof data !== "object") {
    throw new HttpsError("invalid-argument", "data gerekli (object).");
  }
  const { model, input } = data;
  if (!model || typeof model !== "string") {
    throw new HttpsError("invalid-argument", "model gerekli (string).");
  }
  if (!input || typeof input !== "object") {
    throw new HttpsError("invalid-argument", "input gerekli (object).");
  }

  const replicate = getReplicateClient();
  const output = await replicate.run(model, { input });

  return { output };
});

// ---------- Kutla uygulamasına özel callable'lar (aynı proxy, aynı key'ler) ----------

/**
 * Görsel prompt üretir (GPT). İstemci: { eventName, eventType, isLandscape } → { prompt }
 */
exports.generateImagePrompt = onCall(async (request) => {
  const { eventName, eventType, isLandscape } = request.data || {};
  if (!eventName || !eventType) {
    throw new HttpsError("invalid-argument", "eventName ve eventType gerekli.");
  }
  const typeLabel =
    eventType === "milli"
      ? "Milli Bayram (national holiday)"
      : eventType === "dini"
        ? "Dini Bayram (religious holiday)"
        : "Özel Gün (special occasion)";

  const systemPrompt = `You are an expert at writing DALL-E 3 image prompts for greeting card BACKGROUND images. The user gives you a Turkish special day. You output exactly ONE prompt in English, for DALL-E 3 only.
CRITICAL RULES:
- NO PEOPLE: The image must contain ZERO humans. No faces, no portraits, no silhouettes, no figures, no hands, no crowd. Use ONLY inanimate elements: symbols, objects, landscapes, architecture, flags, flowers, monuments (from distance, no people), nature, still life, colors, and cultural objects that clearly represent the occasion.
- National holidays (milli bayram), religious holidays (dini bayram), and special days (özel gün) are sacred and important. The image must be RESPECTFUL and ACCURATE.
- The image must CONCRETELY and CLEARLY represent ONLY this specific occasion through symbols and scenes without any person. No text, NO letters, NO numbers, NO logos, NO watermarks anywhere in the image.
- Output ONLY the DALL-E prompt in English. No explanations, no quotes, no "Prompt:" prefix, no markdown. Just the single prompt text.`;

  let userPrompt = `Create a DALL-E 3 prompt for this occasion. IMPORTANT: The image must have NO people. Use only symbols, objects, landscapes, flags, architecture, nature, or still life that represent the day.
Name: ${eventName}
Type: ${typeLabel}`;
  if (isLandscape) {
    userPrompt += "\nFormat: Landscape (wide) composition suitable for 16:9.";
  } else {
    userPrompt += "\nFormat: Square composition.";
  }
  userPrompt += "\n\nOutput only the single English prompt, nothing else.";

  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 280,
    temperature: 0.6,
  });
  const prompt = (completion.choices?.[0]?.message?.content ?? "").trim();
  return { prompt };
});

/**
 * Görsel üretir (DALL-E 3 veya Replicate flux-schnell). İstemci: { prompt, size?, provider } → { imageUrl }
 */
exports.generateImage = onCall(async (request) => {
  const { prompt, size, provider } = request.data || {};
  if (!prompt) throw new HttpsError("invalid-argument", "prompt gerekli.");
  const useReplicate =
    provider === "replicateFluxSchnell" || provider === undefined || provider === null;

  if (useReplicate) {
    const replicate = getReplicateClient();
    const output = await replicate.run("black-forest-labs/flux-schnell", {
      input: { prompt },
    });
    const imageUrl = typeof output === "string" ? output : Array.isArray(output) ? output[0] : output?.url ?? null;
    if (!imageUrl) throw new HttpsError("internal", "Replicate görsel URL döndürmedi.");
    return { imageUrl: String(imageUrl) };
  }

  const openai = getOpenAIClient();
  const imageSize = size || "1024x1024";
  const resp = await openai.images.generate({
    model: "dall-e-3",
    prompt,
    n: 1,
    size: imageSize,
    quality: "hd",
    response_format: "url",
  });
  const imageUrl = resp.data?.[0]?.url;
  if (!imageUrl) throw new HttpsError("internal", "OpenAI görsel URL döndürmedi.");
  return { imageUrl };
});

/**
 * Kutlama mesajı üretir (GPT). İstemci: { eventName, tone, companyName? } → { message }
 */
exports.generateMessage = onCall(async (request) => {
  const { eventName, tone, companyName } = request.data || {};
  if (!eventName || !tone) {
    throw new HttpsError("invalid-argument", "eventName ve tone gerekli.");
  }
  if (tone === "custom") return { message: "" };

  const isShort = tone === "short";
  const systemPrompt = isShort
    ? `Sen kutlama görselleri için çok kısa mesaj yazan bir yazarsın. Türkçe yaz.
KESİN KURALLAR (Kısa ton):
- Mesaj TEK cümle, maksimum 10-12 kelime
- Görsel üzerinde tek satırda okunacak kadar kısa
- Emoji KULLANMA, hashtag KULLANMA
- Sadece mesajı yaz, başka hiçbir şey yazma`
    : `Sen profesyonel kutlama mesajı yazan bir yazarsın. Türkçe yaz.
KURALLAR:
- Mesaj 1-2 cümle, etkili ve okunabilir olsun; çok uzun tutma
- Emoji KULLANMA, hashtag KULLANMA
- Sadece mesajı yaz, başka hiçbir şey yazma
- Klişe kalıplardan kaçın, özgün ol`;

  const toneDesc =
    tone === "corporate"
      ? "Resmi ve kurumsal."
      : tone === "friendly"
        ? "Samimi ve sıcak."
        : tone === "enthusiastic"
          ? "Coşkulu ve enerjik."
          : "Çok kısa, tek cümle, max 12 kelime.";
  let userPrompt = `"${eventName}" için kutlama mesajı yaz.\nTon: ${toneDesc}`;
  if (companyName && String(companyName).trim()) {
    userPrompt += `\nFirma: ${String(companyName).trim()}`;
  }

  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 90,
    temperature: 0.9,
  });
  const message = (completion.choices?.[0]?.message?.content ?? "").trim();
  return { message };
});
