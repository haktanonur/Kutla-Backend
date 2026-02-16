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

  const systemPrompt = `You write DALL-E 3 image prompts for greeting card backgrounds. The user gives a Turkish special day. Output exactly ONE prompt in English.
CRITICAL:
- NO PEOPLE: zero humans, faces, silhouettes, figures, hands, crowds. Only inanimate elements: symbols, objects, landscapes, architecture, flags, flowers, monuments (no people), nature, still life, cultural objects that CONCRETELY represent THIS specific occasion.
- National and religious holidays are sacred. Be RESPECTFUL and accurate to the meaning of the day.
- Be CONCRETE: name specific symbols, colors, and scenes that belong to this day only (e.g. for Ramadan: crescent, lanterns, dates, night sky; for Victory Day: specific monuments, dawn, Turkish motifs). Avoid generic "celebration" or "festive" filler.
- VARY every time: use different composition (close-up of objects / wide scene / still life / atmosphere), different lighting (golden hour, night, soft morning), and different focal elements. Do not repeat the same sentence structure or the same opening words.
- ABSOLUTELY NO TEXT ON THE IMAGE: no words, no letters, no numbers, no captions, no labels, no signs, no writing, no watermarks, no logos. The image must be PURE VISUAL ONLY—anything that could be read as text is forbidden. Add at the end of your prompt: "no text, no words, no letters, no writing."
- Output ONLY the English prompt. No explanation, no quotes, no "Prompt:" prefix.`;

  const compositionHints = [
    "Focus on a specific symbolic object or still life.",
    "Focus on a wide atmospheric scene (sky, landscape, architecture).",
    "Focus on light and color that evoke this day.",
  ];
  const hint = compositionHints[Math.floor(Math.random() * compositionHints.length)];

  let userPrompt = `Occasion: ${eventName} (${typeLabel}). ${hint}
NO people. NO text/words/letters on the image—pure visual only. Represent this day CONCRETELY with symbols and scenes.`;
  if (isLandscape) {
    userPrompt += " Format: landscape 16:9.";
  } else {
    userPrompt += " Format: square.";
  }
  userPrompt += "\n\nEnd your prompt with: no text, no words, no letters. Output only the single English prompt.";

  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 280,
    temperature: 0.85,
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
    const promptNoText = prompt.replace(/\s*\.?\s*$/, "") + ". No text, no words, no letters, no writing in the image.";
    const output = await replicate.run("black-forest-labs/flux-schnell", {
      input: { prompt: promptNoText },
    });
    const imageUrl = typeof output === "string" ? output : Array.isArray(output) ? output[0] : output?.url ?? null;
    if (!imageUrl) throw new HttpsError("internal", "Replicate görsel URL döndürmedi.");
    return { imageUrl: String(imageUrl) };
  }

  const openai = getOpenAIClient();
  const imageSize = size || "1024x1024";
  const promptNoText = prompt.replace(/\s*\.?\s*$/, "") + " No text, no words, no letters, no writing.";
  const resp = await openai.images.generate({
    model: "dall-e-3",
    prompt: promptNoText,
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
    ? `Kutlama kartı görselinin ÜZERİNE yazılacak mesaj. Türkçe. Görsele SIĞMALI.
- MAKSIMUM 6-8 KELİME. Tek cümle, tek satır. Daha uzun yazma.
- Emoji ve hashtag YOK. Sadece mesaj.
- Farklı açılışlar kullan; "Bu özel günümüzde" gibi uzun kalıplardan kaçın. Kısa ve öz.`
    : `Kutlama kartı görselinin ÜZERİNE yazılacak mesaj. Türkçe. Görsele SIĞMALI.
- TEK CÜMLE, MAKSIMUM 10-12 KELİME. Uzun cümleler yasak—görselde tek satırda okunacak.
- Emoji ve hashtag yok. Özgün ve tekrarsız; o güne özgü kısa bir dilek.`;

  const toneDesc =
    tone === "corporate"
      ? "Resmi, kısa."
      : tone === "friendly"
        ? "Samimi, kısa."
        : tone === "enthusiastic"
          ? "Coşkulu, kısa."
          : "Çok kısa, max 6-8 kelime.";

  let userPrompt = `"${eventName}" için görsel üstüne sığacak kısa kutlama mesajı. Ton: ${toneDesc}. TEK CÜMLE, az kelime.`;
  if (companyName && String(companyName).trim()) {
    userPrompt += ` Firma: ${String(companyName).trim()}`;
  }
  userPrompt += "\n\nUzun yazma; görsele sığmalı (max 10-12 kelime).";

  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    max_tokens: 72,
    temperature: 0.92,
  });
  const message = (completion.choices?.[0]?.message?.content ?? "").trim();
  return { message };
});
