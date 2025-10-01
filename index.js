// server.js
// WhatsApp Flows webhook with RSA-OAEP(SHA-256) + AES-GCM decryption

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

/* -------------------------- Env & Key Setup -------------------------- */

const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

if (!WHATSAPP_TOKEN || !WHATSAPP_API_URL || !GOOGLE_SCRIPT_URL) {
  console.warn(
    "[WARN] Missing one or more env vars: WHATSAPP_TOKEN, WHATSAPP_API_URL, GOOGLE_SCRIPT_URL"
  );
}

// Load the private key and create a KeyObject (safer + lets us inspect details)
const PRIVATE_KEY_PEM = fs.readFileSync("keys/private_plain.key", "utf8");
const PRIVATE_KEY = crypto.createPrivateKey(PRIVATE_KEY_PEM);

/* -------------------------- Small Utilities -------------------------- */

// Convert base64url → Buffer (Meta commonly uses base64url)
function b64urlToBuf(s) {
  if (typeof s !== "string" || !s.length) return Buffer.alloc(0);
  const pad = "=".repeat((4 - (s.length % 4)) % 4);
  const b64 = (s + pad).replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(b64, "base64");
}

// Coalesce possible field names for the GCM tag in the incoming body
function getAuthTagFromBody(body) {
  return (
    body.authentication_tag ||
    body.auth_tag ||
    body.tag ||
    body.gcm_tag ||
    null
  );
}

/* ---------------------------- Cryptography --------------------------- */

// Decrypt the AES key using RSA-OAEP (SHA-256)
function decryptAESKey(encryptedKeyB64url) {
  const encKey = b64urlToBuf(encryptedKeyB64url);

  // Optional sanity check: ciphertext length must equal modulus size (bytes)
  const keyBytes = PRIVATE_KEY.asymmetricKeyDetails
    ? PRIVATE_KEY.asymmetricKeyDetails.modulusLength / 8
    : null;

  if (keyBytes && encKey.length !== keyBytes) {
    throw new Error(
      `Encrypted AES key length (${encKey.length}) != RSA modulus bytes (${keyBytes}). ` +
        `This usually means the private key does not match the public key registered with WhatsApp.`
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

// Decrypt the payload using AES-GCM
function decryptPayload({ encrypted_flow_data, initial_vector, authentication_tag }, aesKey) {
  const iv = b64urlToBuf(initial_vector);            // typically 12 bytes
  const ct = b64urlToBuf(encrypted_flow_data);       // ciphertext bytes
  const tag = b64urlToBuf(authentication_tag);       // 16 bytes

  // Pick AES variant by key length
  const alg =
    aesKey.length === 32 ? "aes-256-gcm" :
    aesKey.length === 24 ? "aes-192-gcm" :
    aesKey.length === 16 ? "aes-128-gcm" :
    (() => { throw new Error(`Unexpected AES key length: ${aesKey.length}`) })();

  const decipher = crypto.createDecipheriv(alg, aesKey, iv);
  decipher.setAuthTag(tag);

  const out = Buffer.concat([decipher.update(ct), decipher.final()]);
  return JSON.parse(out.toString("utf8"));
}

/* ------------------------------ Routes ------------------------------ */

// Health check
app.get("/webhook/health-check", (_req, res) => {
  res.status(200).json({ status: "ok" });
});

// Main webhook
app.post("/webhook", async (req, res) => {
  try {
    // Expect base64url strings for these fields (naming per Meta Flows)
    const {
      encrypted_flow_data,
      encrypted_aes_key,
      initial_vector,
    } = req.body;

    const authentication_tag = getAuthTagFromBody(req.body);

    if (!encrypted_flow_data || !encrypted_aes_key || !initial_vector || !authentication_tag) {
      return res
        .status(400)
        .send(
          "Missing encrypted fields. Need: encrypted_flow_data, encrypted_aes_key, initial_vector, authentication_tag"
        );
    }

    // (Optional) quick diagnostics, no secrets
    if (process.env.LOG_SIZES === "1") {
      const keyBytes = PRIVATE_KEY.asymmetricKeyDetails
        ? PRIVATE_KEY.asymmetricKeyDetails.modulusLength / 8
        : null;
      console.log({
        encKeyLen: b64urlToBuf(encrypted_aes_key).length,
        rsaBytes: keyBytes,
        ivLen: b64urlToBuf(initial_vector).length,
        tagLen: b64urlToBuf(authentication_tag).length,
        ctLen: b64urlToBuf(encrypted_flow_data).length,
      });
    }

    // Decrypt
    const aesKey = decryptAESKey(encrypted_aes_key);
    const payload = decryptPayload(
      { encrypted_flow_data, initial_vector, authentication_tag },
      aesKey
    );

    // Handle ping (keep-alive) signal
    if (payload.action === "ping") {
      return res.status(200).json({ status: "active" });
    }

    // Your business logic
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
      await sendText(
        from,
        "✨ That’s our top 10. Type *start over* to search again."
      );
    }

    res.sendStatus(200);
  } catch (err) {
    // Safe structured log (no secrets)
    console.error("Webhook error:", {
      name: err.name,
      message: err.message,
      code: err.code,
      openssl: err.opensslErrorStack,
    });
    res.status(500).send("Something went wrong.");
  }
});

/* ------------------------ WhatsApp Send Helpers ---------------------- */

async function sendText(to, message) {
  return axios.post(
    WHATSAPP_API_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
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
        header: {
          type: "image",
          image: { link: d.image_url },
        },
        body: {
          text: `💎 *${d.title}*\n${d.subtitle}\n📄 Certificate: ${d.certificate_url}`,
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: `add_to_cart::${d.stone_id}`,
                title: "🛒 Add to Cart",
              },
            },
          ],
        },
      },
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
    }
  );
}

/* ------------------------------ Server ------------------------------ */

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  const keyBits = PRIVATE_KEY.asymmetricKeyDetails
    ? PRIVATE_KEY.asymmetricKeyDetails.modulusLength
    : "unknown";
  console.log(`✅ Flow webhook listening on port ${PORT} (RSA key: ${keyBits} bits)`);
});
