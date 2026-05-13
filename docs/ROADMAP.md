# TON Poker Platform — Roadmap

## MVP (Weeks 1–8)

### Week 1–2: Foundation
- [ ] Monorepo setup (Turborepo)
- [ ] PostgreSQL schema migration tooling (pg-migrate)
- [ ] Fastify API server with Telegram auth
- [ ] JWT auth flow
- [ ] User upsert on Telegram login
- [ ] Basic balance endpoints

### Week 3–4: Core Game Engine
- [ ] Deck shuffling with CSPRNG (provably fair)
- [ ] Hand evaluator (7-card best hand)
- [ ] Game state machine (preflop → river → showdown)
- [ ] Action validation
- [ ] Pot calculation + side pots

### Week 5–6: Real-time Server
- [ ] Socket.IO game server
- [ ] Table management
- [ ] Hand lifecycle (start → deal → action → advance → settle)
- [ ] Rake distribution (atomic)
- [ ] Player disconnect/reconnect handling

### Week 7: TON Integration
- [ ] Deposit monitoring (poll-based initially)
- [ ] Balance credit with idempotency
- [ ] Withdrawal flow with approval
- [ ] TON Connect 2.0 wallet linking

### Week 8: Frontend MVP
- [ ] Next.js + Tailwind setup
- [ ] Telegram Mini App initialization
- [ ] Lobby screen (join club, list tables)
- [ ] Poker table UI
- [ ] Action buttons (fold/check/call/raise/all-in)
- [ ] My hand cards display
- [ ] Basic wallet screen (balance, deposit info)

**MVP Deliverable:** Playable Texas Hold'em within Telegram, one club, TON deposits/withdrawals

---

## Alpha (Weeks 9–14)

- [ ] Club creation and management UI
- [ ] Invite code system
- [ ] Club owner analytics dashboard
- [ ] Admin dashboard (platform owner)
- [ ] Fraud detection system (async)
- [ ] Hand history storage + replay
- [ ] Multi-table support
- [ ] Agent/referral commission system
- [ ] Rakeback configuration
- [ ] Sit out / time bank
- [ ] Provably fair seed reveal at hand end
- [ ] CI/CD pipeline (GitHub Actions)
- [ ] Staging environment on Railway/Render

---

## Beta (Weeks 15–20)

- [ ] Tournament mode (sit-n-go, MTT)
  - [ ] Blind structure progression
  - [ ] ICM payouts
  - [ ] Registration/re-buy/addon
- [ ] VIP/rakeback tiers
- [ ] Push notifications via Telegram Bot API
- [ ] Anti-collusion analytics improvements
- [ ] Rate limiting hardening
- [ ] Load testing (Artillery or k6)
- [ ] Read replica for analytics queries
- [ ] Redis Sentinel or Cluster for HA
- [ ] Cloudflare WAF integration
- [ ] Withdrawal queue processor hardening

---

## Production (Weeks 21–28)

- [ ] TON webhook-based deposit monitoring (replace polling)
- [ ] Multi-language support (EN, RU, PT)
- [ ] Mobile UI polish pass
- [ ] Club owner mobile management app
- [ ] Platform analytics (Grafana + Prometheus)
- [ ] Automated daily/weekly reports to club owners via Telegram
- [ ] KYC/AML integration (for jurisdictions requiring it)
- [ ] Legal review + terms of service
- [ ] Security audit (external penetration test)
- [ ] Public launch

---

## Scalability Architecture (Post-launch)

```
Current (MVP):           Target (Scale):
─────────────            ─────────────────────────────
1 API server             Kubernetes cluster (3+ replicas)
1 Game server            10+ game servers + Redis Cluster
1 Postgres               Primary + 2 Read Replicas
1 Redis                  Redis Cluster (3 shards)
Poll-based TON           TON indexer (dedicated node or Toncenter Pro)
Manual deploys           ArgoCD GitOps
```

## Security Checklist (Pre-Launch)

### Cryptographic
- [x] CSPRNG deck shuffle (no Math.random)
- [x] Deck hash committed before dealing
- [x] Seed revealed at hand end (provably fair)
- [ ] TON Connect proof verification

### Financial
- [x] Ledger is append-only (no UPDATE on financial records)
- [x] Idempotency keys on all credits
- [x] Balance constraint (no negative balance trigger)
- [x] Atomic rake distribution
- [ ] Withdrawal multi-sig for large amounts
- [ ] Daily withdrawal limit per user

### Network
- [x] Server-authoritative (no client game state trusted)
- [x] Action validation server-side
- [x] JWT verification on every request
- [x] Telegram HMAC signature verification
- [x] Rate limiting per user + per IP
- [ ] WebSocket payload size limits
- [ ] DDoS protection via Cloudflare

### Infrastructure
- [ ] All secrets in environment variables (never in code)
- [ ] Wallet mnemonic in secrets manager (AWS Secrets Manager / Vault)
- [ ] Database connections over TLS
- [ ] Audit log for all admin actions
- [ ] Automated backups (pg_dump daily, tested restores)
- [ ] Intrusion detection alerts
