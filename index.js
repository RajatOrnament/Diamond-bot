const express = require("express");
const axios = require("axios");
const bodyParser = require("body-parser");

const app = express();
app.use(bodyParser.json());

// ⚠️ Replace these with your real values:
const GOOGLE_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwxZ143MPAtAfRm7LAKuZO0v4xNGDDzSrByU91GBg4JNS7DskcitNA8EHOvUIcYFeH6/exec";
const WHATSAPP_API_URL = "https://graph.facebook.com/v19.0/825287120660540/messages";
const WHATSAPP_TOKEN = "EAAUEOj59GSsBPRIvhydOfomIRx0YOUaVeF8Y4GkSLZAz2F8ISrkrD22ApUwNWspbL87A9yVuq9elOCjeIQoEhdQrsZAaZCdEPsxFIzZBIOgDxhpTIeXl2CA8YmXlBbxGW1GBGXDWQbsiRxZAO7tVeLBCDvBts9dFEMmvZAldPWDnj6UpC8pU7Jx0uyaYIPjZBWDCW12CWFfJR3thQDve1EfrJ3IjZCLzZAm1HcahET8Fv6wd93AZDZD";

app.post("/webhook", async (req, res) => {
  try {
    const userData = req.body;
    const from = userData.from || userData.contacts?.[0]?.wa_id;

    // Handle "start over"
    if (userData.message?.toLowerCase?.().includes("start over")) {
      await sendText(from, "🔁 Restarting your diamond search...");
      // Optionally trigger Flow again (if you want)
      return res.sendStatus(200);
    }

    // Handle "add_to_cart::<stone_id>"
    if (userData.button?.payload?.startsWith("add_to_cart::")) {
      const stoneId = userData.button.payload.split("::")[1];
      await sendText(from, `✅ Diamond ${stoneId} added to your cart!`);
      return res.sendStatus(200);
    }

    // FLOW filters:
    const filters = {
      shape: userData.shape,
      min_carat: userData.min_carat,
      max_carat: userData.max_carat,
      color: userData.color,
      clarity: userData.clarity
    };

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
    console.error("❌ Error in webhook:", err.message);
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
          text: `💎 *${d.title}*\n${d.subtitle}\n📄 Certificate:\n${d.certificate_url}`
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
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
