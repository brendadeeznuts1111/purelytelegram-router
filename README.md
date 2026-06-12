# PurelyTelegram Router (PT-Router)

**Zero-abstraction email → Telegram context router for Purelymail + betting/payment workflows.**

Lightweight, production-grade Cloudflare Email Worker that intelligently routes emails from Purelymail to specific Telegram channels and supergroups based on recipient address, keywords, and context. Built for fast betting ops, payments, customer support, and account alerts.

## Overview

PurelyTelegram Router is a minimal, event-driven system that forwards incoming emails from your Purelymail domain to the right Telegram channels/supergroups in real time.

It uses **Cloudflare Email Workers** to:
- Parse recipient address (`payments@`, `support@`, `bet@`, `alerts@`, etc.)
- Scan subject/body for context (payments, support issues, betting activity, limits, steam moves, deposits, etc.)
- Route formatted notifications to dedicated Telegram channels with proper MarkdownV2
- Keep Purelymail as the source of truth while adding instant team visibility

This replaces Gmail/Zapier hops with a clean, direct pipeline that fits your existing Cloudflare + Bun + Telegram tooling.

## Key Features

- Fully configurable routing table (priority-ordered rules)
- Betting/payments-specific keyword support out of the box (limits, steam, deposits, wagers, support tickets)
- Backup email forwarding (optional archive copy)
- Low latency, free-tier friendly, easy to maintain
- Follows autophagy principles (small, simple, observable, prune-ready)
- Zero extra dependencies for core path (pure JS + fetch)
- Production-ready: Markdown escaping, error handling, structured logs

## Architecture

```
[Purelymail Domain - Primary MX]
        │
        ├─── Account Routing Rules
        │     (payments@ → forward to payments@notify.yourdomain.com)
        │     (support@ → forward to support@notify.yourdomain.com)
        │     (catch-all or specific for alerts/bet@)
        │
        ▼
[Cloudflare Email Routing on notify.yourdomain.com]
        │     (MX records → Cloudflare)
        │
        ├─── Email Routing Rule: Catch-all / specific → Send to Worker
        │
        ▼
[PurelyTelegram Router Worker]
        ├─── Parse: from, to, subject, body preview (simple MIME text extract)
        ├─── Match against ROUTING_TABLE (recipient match + keyword scan)
        ├─── Format clean notification (from, subject, preview, matched rule)
        ├─── POST to Telegram Bot API (MarkdownV2)
        └─── Optional: message.forward(backupAddress)
```

**Purelymail stays the source of truth** — full emails, attachments, search, and IMAP/webmail access remain there. PT-Router only adds instant contextual notifications to your ops team channels.

## Recommended Setup (Purelymail + Cloudflare)

### 1. Prepare Purelymail
- Log into Purelymail dashboard → **Routing**
- Create targeted rules (exact address recommended for precision):
  - `payments@yourdomain.com` → forward to `payments@notify.yourdomain.com`
  - `support@yourdomain.com` → forward to `support@notify.yourdomain.com`
  - `alerts@yourdomain.com` / `bet@yourdomain.com` → forward to `alerts@notify.yourdomain.com`
- (Optional) Add a catch-all rule forwarding everything else to `router@notify.yourdomain.com` for the default ops channel

### 2. Cloudflare Email Routing + Worker
- Create subdomain `notify.yourdomain.com` (or use a dedicated cheap domain)
- Set MX records for `notify.yourdomain.com` to Cloudflare Email Routing values (see Cloudflare dashboard → Email Routing)
- In Cloudflare Email Routing:
  - Add your domain/subdomain
  - Create rule (or catch-all): Send to Worker → select your new Worker (`pt-router`)
- Deploy the Worker (see below)

### 3. Telegram Bot & Channels
- Create bot via [@BotFather](https://t.me/botfather) → save `BOT_TOKEN`
- Create dedicated channels/supergroups:
  - `#payments-ops`
  - `#betting-alerts`
  - `#customer-support`
  - `#ops-general` (fallback)
- Get `chat_id` for each (use [@userinfobot](https://t.me/userinfobot) or have bot send `/start` in channel and check logs)
- Add the bot as **administrator** with "Send Messages" permission

### 4. Deploy the Worker

```bash
# Clone or init wrangler project
wrangler init pt-router --yes
cd pt-router

# Copy in the src/index.js from this repo (or create it)
wrangler deploy
```

Set the secret:
```bash
wrangler secret put BOT_TOKEN
# Paste your bot token
```

Update `src/index.js` with your actual `chatId` values and tweak `ROUTING_TABLE`.

## Configuration (`src/index.js`)

The routing table is a simple JS array — easy to edit, no external config needed (autophagy).

```js
const ROUTING_TABLE = [
  {
    name: "Payments & Deposits",
    priority: 10,
    match: {
      toIncludes: ["payments@", "pay@", "deposit@", "withdrawal@", "funds@"],
      keywords: ["payment", "deposit", "withdrawal", "invoice", "paid", "funds received", "crypto deposit"]
    },
    targets: [
      { chatId: "-1001234567890", parseMode: "MarkdownV2" } // #payments-ops
    ],
    backupTo: undefined // e.g. "archive@yourdomain.com" if you want Worker-level forward
  },
  {
    name: "Betting Activity & Limits",
    priority: 20,
    match: {
      toIncludes: ["alerts@", "bet@", "wager@", "limits@"],
      keywords: ["limit", "limit increase", "bet placed", "wager", "steam", "line move", "sharp action", "odds change", "new bet"]
    },
    targets: [
      { chatId: "-1009876543210", parseMode: "MarkdownV2" } // #betting-alerts
    ]
  },
  {
    name: "Customer Support",
    priority: 30,
    match: {
      toIncludes: ["support@", "help@", "ticket@", "cs@"]
    },
    targets: [
      { chatId: "-1005555555555", parseMode: "MarkdownV2" } // #customer-support
    ]
  },
  {
    name: "General Ops (Fallback)",
    priority: 100,
    match: {
      toIncludes: ["@"] // matches any remaining
    },
    targets: [
      { chatId: "-1001111111111", parseMode: "MarkdownV2" } // #ops-general
    ]
  }
];
```

**Matching rules:**
- Rules evaluated in `priority` ascending order (lowest first = highest priority)
- `toIncludes`: array of substrings matched against `message.to`
- `keywords`: array of terms searched (case-insensitive) in subject + body preview
- First rule that matches sends to its targets (can expand to multi-target later)
- Fallback always last

## Body Preview

Simple, dependency-free text extraction from the raw MIME stream (first text/plain part or fallback to raw decode). Keeps notifications lightweight while giving enough context ("Payment of $2,500 received from player X").

Full original email + attachments stay in Purelymail.

## Observability & Debugging

- Structured console logs: `routed to #payments-ops via Payments & Deposits rule`
- Use `wrangler tail` or Cloudflare Logs dashboard
- On error: logs the error and still attempts fallback route (never drops silently)

## Why PT-Router?

- **Zero abstraction**: Direct Purelymail → Cloudflare Worker → Telegram. No Zapier, no Gmail forwarders, no extra SaaS.
- **Betting-ops native**: Keywords and recipient patterns tuned for sportsbook emails, limit requests, sharp action alerts, payment rails.
- **Autophagy 10x**: Deliberately small surface. Every line earns its place. Easy to audit, prune, or extend.
- **Fits your stack**: Works alongside your Cloudflare + Bun + Telegram tooling and existing betting ops platforms.

## Roadmap (only if it earns its keep)

- v0.1 — Core routing + Telegram notify (current)
- v0.2 — Improved MIME preview + robust MarkdownV2 escaper
- v0.3 — Optional KV-backed dynamic routes or admin commands via Telegram
- v0.4 — Threaded Telegram conversations (reply to notification → context in Purelymail?)
- Integration hook for your existing bet ticker / line movement systems

This project is intentionally minimal so it stays reliable under load and easy to reason about.

---

**Maintained with autophagy principles.** Small, obvious, production-grade.

If you have questions or want to iterate on rules/keywords specific to your books (Buckeye, etc.), just say the word.
