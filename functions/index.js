/**
 * Kutla – Firebase Cloud Functions
 *
 * Görsel ve metin üretimi tamamen backend'de yapılır.
 * İstemci sadece kullanıcı seçimlerini gönderir: etkinlik, ton, format.
 *
 * AI Modelleri:
 *   Görsel: FLUX.2 Turbo (fal.ai)
 *   Video:  Hailuo 2.3 / Minimax Video (fal.ai)
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { defineString } = require("firebase-functions/params");
const OpenAI = require("openai").default;
const { fal } = require("@fal-ai/client");

const openAiKey = defineString("OPENAI_API_KEY");
const falKey = defineString("FAL_KEY");

// --- Sabitler ---
const FLUX2_TURBO_MODEL = "fal-ai/flux-2/turbo";
const HAILUO_VIDEO_MODEL = "fal-ai/minimax-video/image-to-video";

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

// --- Yardımcı fonksiyonlar ---

function getOpenAIClient() {
  const key = openAiKey.value();
  if (!key) throw new HttpsError("failed-precondition", "OPENAI_API_KEY eksik.");
  return new OpenAI({ apiKey: key });
}

function configureFal() {
  const key = falKey.value();
  if (!key) throw new HttpsError("failed-precondition", "FAL_KEY eksik.");
  fal.config({ credentials: key });
}

function sanitizePrompt(prompt) {
  return prompt.replace(/\s*\.?\s*$/, "") + NO_TEXT_SUFFIX;
}

async function buildImagePrompt(openai, eventName, eventType, imageAspectRatio) {
  const randomStyle = ART_STYLES[Math.floor(Math.random() * ART_STYLES.length)];
  const formatMap = { "1:1": "Square (1:1)", "16:9": "Landscape (16:9)", "9:16": "Portrait (9:16)" };
  const format = formatMap[imageAspectRatio] || "Square (1:1)";

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

function buildVideoPrompt(options) {
  const { eventName, eventType, sourceMessage, cameraMovement, atmosphere } = options;

  const cameraInstructions = {
    zoomIn: "slow zoom in, approaching subject, smooth dolly forward",
    zoomOut: "slow zoom out, revealing full scene, expanding view",
    pan: "smooth horizontal pan across scene, steady lateral movement",
    orbit: "gentle orbit around subject, slow rotating perspective",
    staticShot: "static camera, only scene elements animate, stable frame",
  };

  const atmosphereInstructions = {
    sparkle: "glowing sparkles, shimmering light particles, celebration atmosphere",
    cinematic: "cinematic dramatic lighting, film-like depth of field, premium quality",
    natural: "natural subtle movement, gentle breeze, peaceful atmosphere",
    energetic: "dynamic energetic motion, vibrant colors, festive celebration",
  };

  let toneHint = "clean celebratory atmosphere";
  if (eventType === "dini") {
    toneHint = "respectful and serene religious celebration atmosphere";
  } else if (eventType === "milli") {
    toneHint = "proud and uplifting national celebration atmosphere";
  }

  const camera = cameraInstructions[cameraMovement] || cameraInstructions.zoomIn;
  const atmos = atmosphereInstructions[atmosphere] || atmosphereInstructions.sparkle;

  return [
    `Create a short celebration video for "${eventName || "special day"}".`,
    `${toneHint}.`,
    `Camera: ${camera}.`,
    `Atmosphere: ${atmos}.`,
    "High visual quality, smooth motion, stable composition.",
  ].join(" ");
}

// --- Fal.ai Image Generation (FLUX.2 Turbo) ---

async function runImageGeneration(options) {
  const { prompt, aspectRatio } = options;
  const safePrompt = sanitizePrompt(prompt);
  configureFal();

  // Aspect ratio → Fal.ai image_size enum
  const sizeMap = {
    "1:1": "square_hd",
    "16:9": "landscape_16_9",
    "9:16": "portrait_16_9",
  };
  const imageSize = sizeMap[aspectRatio] || "square_hd";

  const result = await fal.subscribe(FLUX2_TURBO_MODEL, {
    input: {
      prompt: safePrompt,
      image_size: imageSize,
      num_images: 1,
      enable_safety_checker: true,
      output_format: "jpeg",
    },
  });

  const imageUrl = result?.data?.images?.[0]?.url;
  if (!imageUrl) throw new HttpsError("internal", "Fal.ai görsel URL döndürmedi.");
  return String(imageUrl);
}

// ===================================================================
// CALLABLE FUNCTIONS
// ===================================================================

// --- Callable: generateImagePrompt ---
exports.generateImagePrompt = onCall({ enforceAppCheck: true }, async (request) => {
  const { eventName, eventType, isLandscape, imageAspectRatio } = request.data || {};
  if (!eventName) throw new HttpsError("invalid-argument", "eventName zorunludur.");
  const openai = getOpenAIClient();
  const ratio = imageAspectRatio || (isLandscape ? "16:9" : "1:1");
  const prompt = await buildImagePrompt(openai, eventName, eventType ?? null, ratio);
  return { prompt };
});

// --- Callable: generateImage ---
exports.generateImage = onCall({ enforceAppCheck: true }, async (request) => {
  const { eventName, eventType, isLandscape, imageAspectRatio } = request.data || {};
  const aspectRatio = imageAspectRatio || (isLandscape ? "16:9" : "1:1");

  let prompt;
  if (eventName != null && eventName !== "") {
    const openai = getOpenAIClient();
    prompt = await buildImagePrompt(openai, eventName, eventType ?? null, aspectRatio);
  } else {
    const legacyPrompt = request.data?.prompt;
    if (!legacyPrompt) throw new HttpsError("invalid-argument", "eventName veya prompt zorunludur.");
    prompt = legacyPrompt;
  }

  const imageUrl = await runImageGeneration({ prompt, aspectRatio });
  return { imageUrl };
});

// --- Callable: generateMessage ---
exports.generateMessage = onCall({ enforceAppCheck: true }, async (request) => {
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

// --- Genel proxy: callOpenAI ---
exports.callOpenAI = onCall({ enforceAppCheck: true }, async (request) => {
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

// --- Callable: createVideoGeneration (Hailuo 2.3 / Minimax Video) ---
// fal.subscribe() sonucu bekler — iOS tarafında polling gerekmez.
exports.createVideoGeneration = onCall(
  {
    enforceAppCheck: true,
    timeoutSeconds: 300,     // Video üretimi 30-120sn sürebilir
    memory: "512MiB",
  },
  async (request) => {
    const {
      sourceImageUrl,
      eventName,
      eventType,
      sourceMessage,
      cameraMovement = "zoomIn",
      atmosphere = "sparkle",
    } = request.data || {};

    if (!sourceImageUrl || typeof sourceImageUrl !== "string") {
      throw new HttpsError("invalid-argument", "sourceImageUrl zorunludur.");
    }

    const prompt = buildVideoPrompt({
      eventName: eventName || "",
      eventType: eventType || "",
      sourceMessage: sourceMessage || "",
      cameraMovement: cameraMovement || "zoomIn",
      atmosphere: atmosphere || "sparkle",
    });

    configureFal();

    let result;
    try {
      result = await fal.subscribe(HAILUO_VIDEO_MODEL, {
        input: {
          prompt,
          image_url: sourceImageUrl,
          prompt_optimizer: true,
        },
      });
    } catch (error) {
      console.error("Fal.ai video generation hatası:", error);
      throw new HttpsError(
        "internal",
        `Video üretim hatası: ${error?.message || "Bilinmeyen hata"}`
      );
    }

    const videoUrl = result?.data?.video?.url;
    if (!videoUrl) {
      console.error("Fal.ai video URL alınamadı. result:", JSON.stringify(result));
      throw new HttpsError("internal", "Video URL alınamadı.");
    }

    return { videoUrl: String(videoUrl) };
  }
);
