/**
 * PurelyTelegram Router (PT-Router)
 * Cloudflare Email Worker — routes Purelymail emails to Telegram channels
 * 
 * v0.1 — Core implementation (autophagy-first)
 * - Priority-based routing table
 * - Recipient + keyword matching
 * - MarkdownV2 safe notifications
 * - Simple body preview from raw MIME
 * - Optional backup forward
 * - Strong error handling + fallback
 */

const ROUTING_TABLE = [
  {
    name: "Payments & Deposits",
    priority: 10,
    match: {
      toIncludes: ["payments@", "pay@", "deposit@", "withdrawal@", "funds@"],
      keywords: ["payment", "deposit", "withdrawal", "invoice", "paid", "funds received", "crypto deposit"]
    },
    targets: [
      // ← REPLACE with your real channel/supergroup chat ID (negative number)
      { chatId: "-1001234567890", parseMode: "MarkdownV2" }
    ],
    backupTo: undefined // e.g. "archive@yourdomain.com"
  },
  {
    name: "Betting Activity & Limits",
    priority: 20,
    match: {
      toIncludes: ["alerts@", "bet@", "wager@", "limits@"],
      keywords: ["limit", "limit increase", "bet placed", "wager", "steam", "line move", "sharp action", "odds change", "new bet"]
    },
    targets: [
      { chatId: "-1009876543210", parseMode: "MarkdownV2" } // ← REPLACE
    ]
  },
  {
    name: "Customer Support",
    priority: 30,
    match: {
      toIncludes: ["support@", "help@", "ticket@", "cs@"]
    },
    targets: [
      { chatId: "-1005555555555", parseMode: "MarkdownV2" } // ← REPLACE
    ]
  },
  {
    name: "General Ops (Fallback)",
    priority: 100,
    match: {
      toIncludes: ["@"] // always matches anything remaining
    },
    targets: [
      { chatId: "-1001111111111", parseMode: "MarkdownV2" } // ← REPLACE with your #ops channel
    ]
  }
];

/** Escape text for Telegram MarkdownV2 */
function escapeMarkdownV2(text = "") {
  return String(text).replace(/([_*[\]()~`>#+─=|{}.!])/g, "\\$1");
}

/** Read ReadableStream to string */
async function streamToText(stream) {
  if (!stream) return "";
  const reader = stream.getReader();
  let result = "";
  const decoder = new TextDecoder("utf-8");
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    result += decoder.decode(value, { stream: true });
  }
  return result;
}

/** Create a clean, short preview from raw email text */
function getBodyPreview(rawText = "") {
  if (!rawText) return "";
  // Basic cleanup for readability in Telegram
  let cleaned = rawText
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/Content-Type:.*?\n/gi, "")
    .replace(/Content-Transfer-Encoding:.*?\n/gi, "")
    .trim();

  const maxLen = 420;
  return cleaned.length > maxLen 
    ? cleaned.slice(0, maxLen) + "..." 
    : cleaned;
}

/** Find the highest-priority matching rule */
function findMatchingRule(message, subject, bodyPreview) {
  const tos = Array.isArray(message.to) 
    ? message.to.map(t => String(t).toLowerCase()) 
    : [String(message.to || "").toLowerCase()];

  const keywordText = `${subject} ${bodyPreview}`.toLowerCase();

  // Already sorted by priority in table, but ensure order
  const sorted = [...ROUTING_TABLE].sort((a, b) => a.priority - b.priority);

  for (const rule of sorted) {
    const toHit = rule.match.toIncludes?.some(inc =>
      tos.some(to => to.includes(inc.toLowerCase()))
    );
    const kwHit = rule.match.keywords?.some(kw =>
      keywordText.includes(kw.toLowerCase())
    );

    if (toHit || kwHit) {
      return rule;
    }
  }
  return null;
}

/** Send a formatted message to one Telegram target */
async function sendToTelegram(target, text, env) {
  const url = `https://api.telegram.org/bot${env.BOT_TOKEN}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: target.chatId,
      text,
      parse_mode: target.parseMode || "MarkdownV2"
    })
  });

  if (!res.ok) {
    const err = await res.text();
    console.error(`Telegram error (${target.chatId}): ${res.status} ${err}`);
    throw new Error(`Telegram send failed: ${res.status}`);
  }

  console.log(`✅ Telegram notification sent → ${target.chatId}`);
}

export default {
  async email(message, env, ctx) {
    console.log(`📨 PT-Router: email from=${message.from} to=${JSON.stringify(message.to)}`);

    // Extract subject safely
    let subject = "(no subject)";
    try {
      subject = message.headers?.get?.("subject") || message.subject || subject;
    } catch (_) {}

    // Extract body preview
    let bodyPreview = "";
    try {
      const rawText = await streamToText(message.raw);
      bodyPreview = getBodyPreview(rawText);
    } catch (e) {
      console.warn("Preview extraction failed:", e.message);
    }

    // Find best rule
    const matchedRule = findMatchingRule(message, subject, bodyPreview);
    const rule = matchedRule || ROUTING_TABLE[ROUTING_TABLE.length - 1]; // fallback

    // Build notification
    const fromEsc = escapeMarkdownV2(message.from || "unknown sender");
    const toEsc = escapeMarkdownV2(
      Array.isArray(message.to) ? message.to.join(", ") : message.to || "unknown"
    );
    const subjEsc = escapeMarkdownV2(subject);
    const previewEsc = escapeMarkdownV2(bodyPreview);

    const emoji =
      rule.name.includes("Payment") ? "💰" :
      rule.name.includes("Betting") ? "📈" :
      rule.name.includes("Support") ? "🛡️" : "📬";

    let text = `${emoji} *${escapeMarkdownV2(rule.name)}*\n\n`;
    text += `*From:* ${fromEsc}\n`;
    text += `*To:* ${toEsc}\n`;
    text += `*Subject:* ${subjEsc}\n\n`;

    if (previewEsc) {
      text += `*Preview:*\n${previewEsc}\n\n`;
    }

    text += `_Processed by PurelyTelegram Router • Purelymail → Telegram_`;

    // Send to all targets for this rule
    const sendTasks = rule.targets.map(target =>
      sendToTelegram(target, text, env).catch(err => {
        console.error(`Send failed for target ${target.chatId}:`, err.message);
      })
    );

    await Promise.allSettled(sendTasks);

    // Optional: forward original email to backup address
    if (rule.backupTo) {
      try {
        await message.forward(rule.backupTo);
        console.log(`📤 Backup forwarded to ${rule.backupTo}`);
      } catch (e) {
        console.error("Backup forward failed:", e.message);
      }
    }

    console.log(`✅ PT-Router complete via rule: ${rule.name}`);
  }
};
