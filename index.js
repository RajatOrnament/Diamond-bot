// index.js — Final Version with RSA-OAEP SHA-256 Fix (Meta-compliant)
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