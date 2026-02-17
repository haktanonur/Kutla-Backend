/**
 * Kutla – Firebase Cloud Functions
 *
 * Görsel ve metin üretimi tamamen backend'de yapılır.
 * İstemci sadece kullanıcı seçimlerini gönderir: etkinlik, ton, format. Sağlayıcı backend'de seçilir.
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const OpenAI = require("openai").default;
const Replicate = require("replicate");

const openAiKey = defineString("OPENAI_API_KEY");
const replicateToken = defineString("REPLICATE_API_TOKEN");

// --- Sabitler ---
const REPLICATE_MODELS = {
  fluxSchnell: "black-forest-labs/flux-schnell",
  sdxl: "stability-ai/sdxl:7762fd07cf82c948538e41f63f77d685e02b063e37e496e96eefd46c929f9bdc",
  stableDiffusion: "stability-ai/stable-diffusion:ac732df83cea7fff18b8472768c88ad041fa750ff7682a21affe81863cbe77e4",
};

const ART_STYLES = [
  "Cinematic Photorealism, 8k, dramatic lighting, raytracing",
  "Modern Digital Art, vector style, clean lines, smooth gradients",
  "Oil Painting, textured, classical fine art style",
  "Double Exposure, blending symbols with nature/sky",
  "Minimalist 3D Render, soft pastel colors, high end design",
  "Watercolor Illustration, artistic, dreamy and soft edges",
  "Turkish Tezhip Art (Islamic illumination), gold details (only for religious days)",
  "Paper Cutout Art, depth and shadows",
];

const NO_TEXT_SUFFIX = " . no text, no writing, no letters, no watermark, high quality, 8k, detailed.";
const NEGATIVE_PROMPT = "text, words, letters, signature, watermark, logo, ugly, deformed, blurry, bad anatomy, distorted face, extra limbs, low quality, grainy.";

// --- İstemci gönderimi ---
const PROVIDER_OPENAI = "openAIDALLE3";
const PROVIDER_FLUX = "replicateFluxSchnell";
const PROVIDER_SDXL = "replicateSdxl";
const PROVIDER_SD = "replicateStableDiffusion";
const PROVIDER_STABILITY_CORE = "stabilityStableImageCore";

function getOpenAIClient() {
  const key = openAiKey.value();
  if (!key) throw new HttpsError("failed-precondition", "OPENAI_API_KEY eksik.");
  return new OpenAI({ apiKey: key });
}

function getReplicateClient() {
  const token = replicateToken.value();
  if (!token) throw new HttpsError("failed-precondition", "REPLICATE_API_TOKEN eksik.");
  return new Replicate({ auth: token });
}

// --- Görsel prompt üretimi (ortak kullanım) ---
async function buildImagePrompt(openai, eventName, eventType, isLandscape) {
  const randomStyle = ART_STYLES[Math.floor(Math.random() * ART_STYLES.length)];
  const format = isLandscape ? "Landscape (16:9)" : "Square (1:1)";

  let safetyInstruction = "NO TEXT, NO LETTERS, NO WATERMARKS. ";
  if (eventType === "dini") {
    safetyInstruction += "ABSOLUTELY NO HUMAN FIGURES, NO FACES, NO ANIMALS. Focus on architecture (mosque), light, geometry, nature.";
  } else {
    safetyInstruction += "Avoid realistic close-up faces (to prevent AI distortion). If humans are needed (e.g. soldiers, police), use silhouettes, artistic representations or distant figures.";
  }

  const systemPrompt = `
    You are an expert AI Art Director for a Turkish Celebration App.
    Your goal is to write a generic-free, specific, and high-quality image prompt based on the "Event Name".

    INSTRUCTIONS:
    1. **ANALYZE THE EVENT:** From the event name, infer what the day represents in Turkey and choose fitting symbols, colors, and mood (e.g. professional days → tools/badges, national days → flags/monuments, religious → moon/lanterns/architecture). Do not output generic scenes like flowers only.
    2. **STYLE:** The image style must be: "${randomStyle}".
    3. **FORMAT:** ${format}.
    4. **SAFETY:** ${safetyInstruction}
    OUTPUT: Provide ONLY the English prompt string. No explanations.
  `;

  const userPrompt = `Event Name: "${eventName}" (Type: ${eventType || "General"}). Create a visual prompt that captures the specific essence and symbols of this day.`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.85,
    max_tokens: 250,
  });

  return (completion.choices?.[0]?.message?.content ?? "").trim();
}

function parseReplicateImageOutput(output) {
  if (typeof output === "string") return output;
  if (Array.isArray(output)) return output[0] ?? null;
  return output?.url ?? output ?? null;
}

function sanitizePrompt(prompt) {
  return prompt.replace(/\s*\.?\s*$/, "") + NO_TEXT_SUFFIX;
}

/** Replicate / OpenAI ile görsel üretir. Prompt zaten hazır. */
async function runImageGeneration(options) {
  const { prompt, provider, size, aspectRatio } = options;
  const safePrompt = sanitizePrompt(prompt);

  if (provider === PROVIDER_OPENAI) {
    const openai = getOpenAIClient();
    const dallESize = size || (aspectRatio === "16:9" ? "1792x1024" : "1024x1024");
    const resp = await openai.images.generate({
      model: "dall-e-3",
      prompt: safePrompt,
      n: 1,
      size: dallESize,
      quality: "standard",
      response_format: "url",
    });
    const imageUrl = resp.data?.[0]?.url;
    if (!imageUrl) throw new HttpsError("internal", "OpenAI görsel URL döndürmedi.");
    return imageUrl;
  }

  if (provider === PROVIDER_STABILITY_CORE) {
    throw new HttpsError("unimplemented", "stabilityStableImageCore için Stability API entegrasyonu yapılandırılmadı.");
  }

  const replicate = getReplicateClient();
  const ratio = aspectRatio || "1:1";

  let modelId = REPLICATE_MODELS.sdxl;
  let inputParams = {
    prompt: safePrompt,
    negative_prompt: NEGATIVE_PROMPT,
    width: 1024,
    height: 1024,
    scheduler: "K_EULER",
    num_inference_steps: 30,
    guidance_scale: 7.5,
  };

  if (provider === PROVIDER_FLUX) {
    modelId = REPLICATE_MODELS.fluxSchnell;
    inputParams = {
      prompt: safePrompt + " --no text --no watermark",
      aspect_ratio: ratio,
      output_format: "jpg",
      output_quality: 90,
    };
  } else if (provider === PROVIDER_SDXL) {
    if (ratio === "16:9") {
      inputParams.width = 1024;
      inputParams.height = 576;
    }
  } else if (provider === PROVIDER_SD) {
    modelId = REPLICATE_MODELS.stableDiffusion;
    if (ratio === "16:9") {
      inputParams.width = 1024;
      inputParams.height = 576;
    }
  }

  const output = await replicate.run(modelId, { input: inputParams });
  const imageUrl = parseReplicateImageOutput(output);
  if (!imageUrl) throw new HttpsError("internal", "Replicate görsel URL döndürmedi.");
  return String(imageUrl);
}

// --- Callable: generateImagePrompt (isteğe bağlı; istemci tek çağrıda generateImage kullanacak) ---
exports.generateImagePrompt = onCall(async (request) => {
  const { eventName, eventType, isLandscape } = request.data || {};
  if (!eventName) throw new HttpsError("invalid-argument", "eventName zorunludur.");
  const openai = getOpenAIClient();
  const prompt = await buildImagePrompt(openai, eventName, eventType ?? null, !!isLandscape);
  return { prompt };
});

// Hangi görsel sağlayıcısının kullanılacağı sadece backend'de belirlenir (env ile değiştirilebilir).
const DEFAULT_IMAGE_PROVIDER = PROVIDER_FLUX;

// --- Callable: generateImage ---
// İstemci sadece kullanıcı seçimlerini gönderir: eventName, eventType, isLandscape.
// Prompt ve sağlayıcı backend'de. Eski kullanım (prompt gönderme) desteklenir.
exports.generateImage = onCall(async (request) => {
  const { eventName, eventType, isLandscape } = request.data || {};
  const aspectRatio = isLandscape ? "16:9" : "1:1";

  let prompt;
  if (eventName != null && eventName !== "") {
    const openai = getOpenAIClient();
    prompt = await buildImagePrompt(openai, eventName, eventType ?? null, !!isLandscape);
  } else {
    const legacyPrompt = request.data?.prompt;
    if (!legacyPrompt) throw new HttpsError("invalid-argument", "eventName veya prompt zorunludur.");
    prompt = legacyPrompt;
  }

  const imageUrl = await runImageGeneration({
    prompt,
    provider: request.data?.provider || DEFAULT_IMAGE_PROVIDER,
    size: request.data?.size || null,
    aspectRatio,
  });
  return { imageUrl };
});

// --- Callable: generateMessage ---
exports.generateMessage = onCall(async (request) => {
  const { eventName, eventType, tone, companyName } = request.data || {};
  if (!eventName || !tone) throw new HttpsError("invalid-argument", "eventName ve tone gerekli.");
  if (tone === "custom") return { message: "" };

  let toneInstruction = "";
  let lengthInstruction = "1 veya 2 tam cümle. (Yaklaşık 15-20 kelime).";
  switch (tone) {
    case "corporate":
      toneInstruction = "Resmi, saygılı, profesyonel ve kurumsal bir dil. 'Siz' dili kullan.";
      break;
    case "friendly":
      toneInstruction = "Sıcak, samimi, içten ve dostane bir dil. 'Sen' veya 'Biz' dili kullan.";
      break;
    case "enthusiastic":
      toneInstruction = "Yüksek enerjili, coşkulu, heyecan verici ve motive edici bir dil. Ünlem kullanımı uygun.";
      break;
    case "short":
      toneInstruction = "Vurucu, etkileyici ve net.";
      lengthInstruction = "Tek bir güçlü cümle. Maksimum 10 kelime. Az ama öz.";
      break;
    default:
      toneInstruction = "Nazik ve kutlayıcı.";
  }

  let contextHint = "";
  if (eventType === "dini") {
    contextHint = "Dini terminolojiye uygun (Hayırlı, Mübarek, Rahmet, Bereket, Dua).";
  } else if (eventType === "milli") {
    contextHint = "Vatansever, gururlu, epik (Kutlu olsun, Minnettarız, İlelebet).";
  } else {
    contextHint = `Bu günün (${eventName}) anlamına özel kelimeler kullan. (Örn: Polis ise 'güven/huzur', Öğretmen ise 'gelecek/ışık').`;
  }

  const systemPrompt = `
    Sen Türkçe metin yazarlığı konusunda uzman bir yapay zekasın.
    GÖREV: "${eventName}" için görsel üzerine yazılacak bir kutlama mesajı oluştur.
    DETAYLAR:
    1. TON: ${toneInstruction}
    2. UZUNLUK: ${lengthInstruction} Asla yarım bırakma.
    3. İÇERİK: ${contextHint}
    4. YASAKLAR: Emoji YOK. Hashtag YOK. "Tırnak işareti" içine alma.
    5. KALİTE: Basit "Kutlu olsun" yazıp geçme. Duyguyu hissettir, edebi olsun.
  `;

  let userPrompt = `Etkinlik: ${eventName}.`;
  if (companyName) {
    userPrompt += ` (Opsiyonel: Mesajın uygun bir yerine veya sonuna ${companyName} adını nazikçe yerleştir veya şirket adına konuşuyormuş gibi yaz.)`;
  }

  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    temperature: 0.9,
    max_tokens: 150,
  });

  let message = (completion.choices?.[0]?.message?.content ?? "").trim();
  message = message.replace(/^["']|["']$/g, "");
  return { message };
});

// --- Genel proxy (mevcut kullanım için) ---
exports.callOpenAI = onCall(async (request) => {
  const { model = "gpt-4o-mini", messages } = request.data || {};
  if (!messages || !Array.isArray(messages)) throw new HttpsError("invalid-argument", "messages dizisi gerekli.");
  const openai = getOpenAIClient();
  const completion = await openai.chat.completions.create({
    model: String(model),
    messages: messages.map((m) => ({ role: m.role || "user", content: m.content })),
  });
  const choice = completion.choices?.[0];
  return {
    message: { role: choice?.message?.role ?? "assistant", content: choice?.message?.content ?? null },
    usage: completion.usage,
  };
});

exports.callReplicate = onCall(async (request) => {
  const { model, input } = request.data || {};
  if (!model || !input) throw new HttpsError("invalid-argument", "model ve input gerekli.");
  const replicate = getReplicateClient();
  const output = await replicate.run(model, { input });
  return { output };
});
