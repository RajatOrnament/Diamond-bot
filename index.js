const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// 🔐 Replace with your actual secrets
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const WHATSAPP_API_URL = process.env.WHATSAPP_API_URL;
const GOOGLE_SCRIPT_URL = process.env.GOOGLE_SCRIPT_URL;

// ✅ Health Check Endpoint for Meta
app.get("/webhook/health-check", (req, res) => {
  res.status(200).json({ status: "ok" });
});

// 🟢 Main Webhook Handler
app.post("/webhook", async (req, res) => {
  try {
    const data = req.body;
    const from = data.from || data.contacts?.[0]?.wa_id;

    // ✅ Handle "start over"
    if (data.message?.toLowerCase?.().includes("start over")) {
      await sendText(from, "🔁 Restarting your diamond search. Please start again.");
      return res.sendStatus(200);
    }

    // ✅ Handle "Add to Cart"
    if (data.button?.payload?.startsWith("add_to_cart::")) {
      const stoneId = data.button.payload.split("::")[1];
      await sendText(from, `✅ Diamond ${stoneId} added to your cart!`);
      return res.sendStatus(200);
    }

    // ✅ Handle Flow submission (filter payload)
    const filters = {
      shape: data.shape,
      min_carat: data.min_carat,
      max_carat: data.max_carat,
      color: data.color,
      clarity: data.clarity
    };

    console.log("Incoming filters:", filters);

    const response = await axios.post(GOOGLE_SCRIPT_URL, filters);
    const diamonds = response.data.diamonds;

    if (!diamonds || diamonds.length === 0) {
      await sendText(from, "❌ No matching diamonds found for your selection.");
    } else {
      for (const d of diamonds) {
        await sendDiamondCard(from, d);
      }
      await sendText(from, "✨ That’s our top 10 picks.\nType *start over* to search again.");
    }

    res.sendStatus(200);
  } catch (err) {
    console.error("❌ Webhook error:", err.message);
    res.status(500).send("Something went wrong.");
  }
});

// ✅ Send text message
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

// ✅ Send image + button card
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
          image: {
            link: d.image_url || "https://yourdomain.com/placeholder.jpg"
          }
        },
        body: {
          text: `💎 *${d.title}*\n${d.subtitle}\n📄 [View Certificate](${d.certificate_url})`
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
  console.log(`🚀 Webhook server running on port ${PORT}`);
});
