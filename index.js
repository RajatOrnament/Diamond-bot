// index.js — Final Version with Decryption using Plain (Unprotected) RSA Key

const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const fs = require("fs");
const crypto = require("crypto");

const app = express();
app.use(bodyParser.json({ limit: "5mb" }));

// Load unencrypted RSA private key
const PRIVATE_KEY = fs.readFileSync("keys/private_plain.key", "utf8");

// Env vars (set these in Render)
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

// Health Check
app.get("/webhook/health-check", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// Decrypt AES key using RSA
function decryptAESKey(encryptedKey) {
  return crypto.privateDecrypt(
    {
      key: PRIVATE_KEY,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING
    },
    Buffer.from(encryptedKey, "base64")
  );
}

// Decrypt Flow payload
function decryptPayload(encryptedData, aesKey, iv) {
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    aesKey,
    Buffer.from(iv, "base64")
  );
  decipher.setAuthTag(Buffer.alloc(16));

  let decrypted = decipher.update(Buffer.from(encryptedData, "base64"), null, "utf8");
  decrypted += decipher.final("utf8");
  return JSON.parse(decrypted);
}

app.post("/webhook", async (req, res) => {
  try {
    const { encrypted_flow_data, encrypted_aes_key, initial_vector } = req.body;

    if (!encrypted_flow_data || !encrypted_aes_key || !initial_vector) {
      return res.status(400).send("Missing encrypted fields");
    }

    const aesKey = decryptAESKey(encrypted_aes_key);
    const decryptedPayload = decryptPayload(encrypted_flow_data, aesKey, initial_vector);

    if (decryptedPayload.action === "ping") {
      return res.status(200).json({ status: "active" });
    }

    const { shape, min_carat, max_carat, color, clarity, from } = decryptedPayload;
    const filters = { shape, min_carat, max_carat, color, clarity };
    const response = await axios.post(GOOGLE_SCRIPT_URL, filters);
    const diamonds = response.data.diamonds;

    if (!diamonds || diamonds.length === 0) {
      await sendText(from, "❌ No matching diamonds found.");
    } else {
      for (const d of diamonds) {
        await sendDiamondCard(from, d);
      }
      await sendText(from, "✨ That’s our top 10. Type *start over* to search again.");
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook decryption error:", err);
    res.status(500).send("Something went wrong.");
  }
});

async function sendText(to, message) {
  return axios.post(
    WHATSAPP_API_URL,
    {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: message }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
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
          image: { link: d.image_url }
        },
        body: {
          text: `💎 *${d.title}*\n${d.subtitle}\n📄 Certificate: ${d.certificate_url}`
        },
        action: {
          buttons: [
            {
              type: "reply",
              reply: {
                id: `add_to_cart::${d.stone_id}`,
                title: "🛒 Add to Cart"
              }
            }
          ]
        }
      }
    },
    {
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json"
      }
    }
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Flow webhook listening on port ${PORT}`);
});