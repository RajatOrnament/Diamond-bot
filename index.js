// server.js
// WhatsApp Flows webhook: RSA-OAEP(SHA-256) + AES-GCM with tag-fallback

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

/* --------------------------- ENV & KEY SETUP --------------------------- */

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;
const VERIFY_TOKEN = process.env.VERIFY_TOKEN || ""; // optional WA GET verify

if (!WHATSAPP_TOKEN || !WHATSAPP_API_URL || !GOOGLE_SCRIPT_URL) {
  console.warn("[WARN] Missing env var(s): WHATSAPP_TOKEN, WHATSAPP_API_URL, GOOGLE_SCRIPT_URL");
}

const PRIVATE_KEY_PEM = fs.readFileSync("keys/private_plain.key", "utf8");
const PRIVATE_KEY = crypto.createPrivateKey(PRIVATE_KEY_PEM);

/* ------------------------------ HELPERS -------------------------------- */

function b64urlToBuf(s) {
  if (typeof s !== "string" || s.length === 0) return Buffer.alloc(0);
  const hasUrlChars = s.includes("-") || s.includes("_");
  const base = hasUrlChars ? s.replace(/-/g, "+").replace(/_/g, "/") : s;
  const pad = "=".repeat((4 - (base.length % 4)) % 4);
  return Buffer.from(base + pad, "base64");
}

function topKeys(obj) {
  try { return Object.keys(obj || {}); } catch { return []; }
}

function deepFindFirst(obj, propName, maxDepth = 8) {
  if (!obj || typeof obj !== "object") return undefined;
  const q = [{ v: obj, d: 0 }];
  while (q.length) {
    const { v, d } = q.shift();
    if (d > maxDepth) continue;
    if (Object.prototype.hasOwnProperty.call(v, propName)) return v[propName];
    const keys = Array.isArray(v) ? v : Object.keys(v);
    for (const k of keys) {
      const child = Array.isArray(v) ? k : v[k];
      if (child && typeof child === "object") q.push({ v: child, d: d + 1 });
    }
  }
  return undefined;
}

function extractEncryptedFields(body) {
  const encrypted_flow_data =
    body.encrypted_flow_data ??
    body.encrypted_data ??
    deepFindFirst(body, "encrypted_flow_data") ??
    deepFindFirst(body, "encrypted_data");

  const encrypted_aes_key =
    body.encrypted_aes_key ??
    body.encrypted_key ??
    deepFindFirst(body, "encrypted_aes_key") ??
    deepFindFirst(body, "encrypted_key");

  const initial_vector =
    body.initial_vector ??
    body.iv ??
    body.initialisation_vector ??
    body.initialization_vector ??
    deepFindFirst(body, "initial_vector") ??
    deepFindFirst(body, "iv") ??
    deepFindFirst(body, "initialisation_vector") ??
    deepFindFirst(body, "initialization_vector");

  // Optional/alternate names for tag if present separately
  const authentication_tag =
    body.authentication_tag ??
    body.auth_tag ??
    body.tag ??
    body.gcm_tag ??
    deepFindFirst(body, "authentication_tag") ??
    deepFindFirst(body, "auth_tag") ??
    deepFindFirst(body, "tag") ??
    deepFindFirst(body, "gcm_tag");

  return { encrypted_flow_data, encrypted_aes_key, initial_vector, authentication_tag };
}

/* ----------------------------- CRYPTO ---------------------------------- */

function decryptAESKey(encryptedKeyB64url) {
  const encKey = b64urlToBuf(encryptedKeyB64url);
  const keyBytes = PRIVATE_KEY.asymmetricKeyDetails
    ? PRIVATE_KEY.asymmetricKeyDetails.modulusLength / 8
    : null;

  if (keyBytes && encKey.length !== keyBytes) {
    throw new Error(
      `Encrypted AES key length (${encKey.length}) != RSA modulus bytes (${keyBytes}). ` +
      `Likely a key mismatch with the public key registered on WhatsApp.`
    );
  }

  return crypto.privateDecrypt(
    {
      key: PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    encKey
  );
}

/**
 * Decrypt AES-GCM.
 * Supports two formats:
 *  A) Separate tag -> use provided authentication_tag
 *  B) Tag appended to the end of encrypted_flow_data -> split last 16 bytes as tag
 */
function decryptPayloadWithFallback({ encrypted_flow_data, initial_vector, authentication_tag }, aesKey) {
  const iv = b64urlToBuf(initial_vector);
  let ct = b64urlToBuf(encrypted_flow_data);
  let tag = authentication_tag ? b64urlToBuf(authentication_tag) : null;

  if (!tag || tag.length === 0) {
    // Fallback: last 16 bytes of ciphertext is the GCM tag
    if (ct.length <= 16) {
      throw new Error("Missing GCM authentication tag and ciphertext too short to infer it.");
    }
    tag = ct.subarray(ct.length - 16);
    ct = ct.subarray(0, ct.length - 16);
    if (process.env.LOG_SIZES === "1") {
      console.log("[GCM fallback] using tag appended to ciphertext", { ctLen: ct.length, tagLen: tag.length });
    }
  }

  const alg =
    aesKey.length === 32 ? "aes-256-gcm" :
    aesKey.length === 24 ? "aes-192-gcm" :
    aesKey.length === 16 ? "aes-128-gcm" :
    (() => { throw new Error(`Unexpected AES key length: ${aesKey.length}`); })();

  const decipher = crypto.createDecipheriv(alg, aesKey, iv);
  decipher.setAuthTag(tag);
  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(out.toString("utf8"));
}

/* ------------------------------ ROUTES --------------------------------- */

// Optional WA GET verification
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];
  if (mode === "subscribe" && token && VERIFY_TOKEN && token === VERIFY_TOKEN) {
    return res.status(200).send(challenge);
  }
  return res.status(403).send("Forbidden");
});

// Health check
app.get("/webhook/health-check", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Main webhook
app.post("/webhook", async (req, res) => {
  try {
    if (req.body && req.body.action === "ping") {
      return res.status(200).json({ status: "active" });
    }

    const fields = extractEncryptedFields(req.body);
    const { encrypted_flow_data, encrypted_aes_key, initial_vector, authentication_tag } = fields;

    // If these three aren't present, it's not a Flow payload; ack 200 so WA doesn't retry
    if (!encrypted_flow_data || !encrypted_aes_key || !initial_vector) {
      if (req.body && (req.body.entry || req.body.object || req.body.field)) {
        if (process.env.LOG_SIZES === "1") console.log("[Ignored non-Flow webhook] keys:", topKeys(req.body));
        return res.sendStatus(200);
      }
      return res.status(400).json({
        error: "Missing encrypted fields",
        need: ["encrypted_flow_data", "encrypted_aes_key", "initial_vector", "authentication_tag (or tag appended)"],
        got_top_level_keys: topKeys(req.body),
      });
    }

    if (process.env.LOG_SIZES === "1") {
      const keyBytes = PRIVATE_KEY.asymmetricKeyDetails
        ? PRIVATE_KEY.asymmetricKeyDetails.modulusLength / 8
        : null;
      console.log({
        encKeyLen: b64urlToBuf(encrypted_aes_key).length,
        rsaBytes: keyBytes,
        ivLen: b64urlToBuf(initial_vector).length,
        tagPresent: !!authentication_tag,
        ctLen: b64urlToBuf(encrypted_flow_data).length,
      });
    }

    const aesKey = decryptAESKey(encrypted_aes_key);
    const payload = decryptPayloadWithFallback(
      { encrypted_flow_data, initial_vector, authentication_tag },
      aesKey
    );

    if (payload.action === "ping") {
      return res.status(200).json({ status: "active" });
    }

    const { shape, min_carat, max_carat, color, clarity, from } = payload;

    const filters = { shape, min_carat, max_carat, color, clarity };
    const response = await axios.post(GOOGLE_SCRIPT_URL, filters);
    const diamonds = response.data?.diamonds || [];

    if (!diamonds.length) {
      await sendText(from, "❌ No matching diamonds found.");
    } else {
      for (const d of diamonds) {
        await sendDiamondCard(from, d);
      }
      await sendText(from, "✨ That’s our top 10. Type *start over* to search again.");
    }

    return res.sendStatus(200);
  } catch (err) {
    console.error("Webhook error:", {
      name: err.name,
      message: err.message,
      code: err.code,
      openssl: err.opensslErrorStack,
    });
    return res.status(500).send("Something went wrong.");
  }
});

/* ------------------------ WHATSAPP SEND HELPERS ------------------------ */

async function sendText(to, message) {
  return axios.post(
    WHATSAPP_API_URL,
    { messaging_product: "whatsapp", to, type: "text", text: { body: message } },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

async function sendDiamondCard(to, d) {
  return axios.post(
    WHATSAPP_API_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "interactive",
      interactive: {
        type: "button",
        header: { type: "image", image: { link: d.image_url } },
        body: { text: `💎 *${d.title}*\n${d.subtitle}\n📄 Certificate: ${d.certificate_url}` },
        action: {
          buttons: [{ type: "reply", reply: { id: `add_to_cart::${d.stone_id}`, title: "🛒 Add to Cart" } }],
        },
      },
    },
    { headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}`, "Content-Type": "application/json" } }
  );
}

/* -------------------------------- SERVER -------------------------------- */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const keyBits = PRIVATE_KEY.asymmetricKeyDetails
    ? PRIVATE_KEY.asymmetricKeyDetails.modulusLength
    : "unknown";
  console.log(`✅ Flow webhook listening on port ${PORT} (RSA key: ${keyBits} bits)`);
});
