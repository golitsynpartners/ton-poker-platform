# TON Poker Platform — Full System Architecture

## Overview

A production-grade club-based poker platform running as a Telegram Mini App.
Two-tier ownership model: Platform Owner → Club Owners → Players.

---

## 1. System Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                     TELEGRAM CLIENTS                            │
│         (Mini App — React/Next.js + TWA SDK)                   │
└────────────────────┬───────────────────────┬────────────────────┘
                     │ HTTPS/WSS              │ HTTPS/WSS
          ┌──────────▼──────────┐  ┌─────────▼──────────┐
          │   API Gateway       │  │  Game WS Gateway   │
          │  (Cloudflare)       │  │  (Cloudflare)      │
          └──────────┬──────────┘  └─────────┬──────────┘
                     │                        │
     ┌───────────────▼────────────────────────▼──────────────┐
     │                 INTERNAL SERVICES                       │
     │                                                         │
     │  ┌─────────────┐  ┌──────────────┐  ┌─────────────┐  │
     │  │  REST API   │  │ Game Server  │  │Wallet Svc   │  │
     │  │  (Fastify)  │  │ (Socket.IO)  │  │(TON/Queue)  │  │
     │  └──────┬──────┘  └──────┬───────┘  └──────┬──────┘  │
     │         │                │                   │         │
     │  ┌──────▼────────────────▼───────────────────▼──────┐ │
     │  │                  PostgreSQL                       │ │
     │  │  (Primary + Read Replicas)                        │ │
     │  └───────────────────────────────────────────────────┘ │
     │  ┌───────────────────────────────────────────────────┐ │
     │  │               Redis Cluster                       │ │
     │  │  (Sessions, Table State, PubSub, Rate Limits)     │ │
     │  └───────────────────────────────────────────────────┘ │
     └─────────────────────────────────────────────────────────┘
                     │
          ┌──────────▼──────────┐
          │   TON Blockchain    │
          │  (Mainnet / RPC)    │
          └─────────────────────┘
```

---

## 2. Two-Tier Ownership Model

```
PLATFORM OWNER
├── Platform fee config (e.g. 40% of all club rake)
├── Global admin dashboard
├── Treasury wallet (receives platform rake)
├── Fraud/risk controls
└── Can freeze clubs/players

    CLUB OWNER (many per platform)
    ├── Club config (rake %, blind structures)
    ├── Player management (invite, ban, approve withdrawals)
    ├── Club treasury wallet
    ├── Analytics dashboard
    └── Agent/referral system
    
        PLAYER (many per club)
        ├── Telegram auth (automatic)
        ├── TON wallet connection
        ├── Club balance (chip representation)
        ├── Deposit / Withdraw TON
        └── Play at tables
```

---

## 3. Rake Flow

```
Pot = 100 TON
Rake = 5% = 5 TON

                    ┌─────────────────┐
                    │   Pot: 100 TON  │
                    └────────┬────────┘
                             │ rake taken
                    ┌────────▼────────┐
                    │  Rake: 5 TON    │
                    └────────┬────────┘
                    split at table close
              ┌─────────────┴─────────────┐
    ┌─────────▼──────────┐      ┌─────────▼──────────┐
    │ Club Owner: 3 TON  │      │ Platform: 2 TON     │
    │ (configurable %)   │      │ (platform_fee_pct)  │
    └────────────────────┘      └─────────────────────┘
    
All rake events are atomic PostgreSQL transactions.
Ledger entries are append-only (never mutate).
```

---

## 4. Security Model

- **Server-authoritative**: Game state lives only on the server
- **Cryptographic deck shuffling**: Fisher-Yates with CSPRNG seed
- **Card commitment scheme**: Deck hash committed before dealing, revealed after hand
- **No client trust**: All actions validated server-side
- **Duplicate prevention**: Idempotency keys on all transactions
- **Anti-collusion**: Seat history analysis, IP tracking, win-rate monitoring
- **Rate limiting**: Per-user, per-IP, per-action via Redis sliding window
- **Telegram auth verification**: HMAC-SHA256 signature check on every request
- **TON tx verification**: Monitor on-chain confirmations, never trust client tx claims

---

## 5. Data Flow: Player Join → Play → Withdraw

```
1. Player opens Telegram Mini App
2. TWA SDK provides initData (signed by Telegram)
3. API verifies HMAC signature → issues JWT
4. Player connects TON wallet (TON Connect 2.0)
5. Player requests deposit → system generates deposit address
6. TON Blockchain confirms tx → balance credited (idempotent)
7. Player joins club (invite code or public)
8. Player sits at table → Socket.IO connection established
9. Hand begins → server shuffles deck with CSPRNG
10. Each action (fold/call/raise) validated server-side
11. Rake deducted atomically at showdown
12. Ledger entries written: player loss, club rake, platform rake
13. Player requests withdrawal → approval flow → TON tx sent
```
