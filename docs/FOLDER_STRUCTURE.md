# Monorepo Folder Structure

```
poker-platform/
├── package.json              # Workspace root
├── turbo.json                # Turborepo pipeline config
├── tsconfig.base.json        # Shared TypeScript config
│
├── packages/                 # Shared libraries (no external deps on services)
│   ├── game-engine/          # Pure poker logic — no DB, no sockets
│   │   └── src/
│   │       ├── deck.ts           # CSPRNG shuffle + card types
│   │       ├── hand-evaluator.ts # 7-card best hand evaluation
│   │       ├── game-state.ts     # Hand state machine
│   │       └── index.ts
│   │
│   ├── shared/               # Shared types + utilities
│   │   └── src/
│   │       ├── types.ts          # Shared DB types
│   │       ├── errors.ts         # Typed error classes
│   │       └── utils.ts
│   │
│   └── ton-sdk/              # TON blockchain integration
│       └── src/
│           ├── ton-client.ts     # Deposit monitor + withdrawal executor
│           └── ton-connect.ts    # TON Connect 2.0 proof verification
│
├── services/                 # Backend microservices
│   ├── api/                  # REST API (Fastify)
│   │   ├── src/
│   │   │   ├── server.ts         # Entry point
│   │   │   ├── config/           # Environment config + validation
│   │   │   ├── middleware/
│   │   │   │   ├── auth.ts           # JWT verify + requireAuth
│   │   │   │   └── telegram-auth.ts  # Telegram HMAC verification
│   │   │   ├── routes/
│   │   │   │   ├── auth.ts           # POST /auth/telegram
│   │   │   │   ├── clubs.ts          # CRUD clubs + tables
│   │   │   │   ├── wallet.ts         # Deposit/withdraw/balance
│   │   │   │   └── admin.ts          # Platform owner dashboard
│   │   │   ├── services/
│   │   │   │   ├── ledger.service.ts     # Financial accounting
│   │   │   │   └── fraud-detection.service.ts
│   │   │   └── db/
│   │   │       ├── schema.sql        # Full PostgreSQL schema
│   │   │       └── migrations/       # pg-migrate files
│   │   └── Dockerfile
│   │
│   ├── game-server/          # WebSocket game engine (Socket.IO)
│   │   ├── src/
│   │   │   ├── server.ts         # Entry point + Socket.IO setup
│   │   │   ├── engine/
│   │   │   │   └── table-manager.ts  # Authoritative table controller
│   │   │   └── socket/
│   │   │       └── events.ts         # C2S + S2C event type definitions
│   │   └── Dockerfile
│   │
│   └── wallet-service/       # TON deposit monitor + withdrawal processor
│       ├── src/
│       │   ├── monitor.ts        # Polls TON blockchain for deposits
│       │   └── processor.ts      # Processes withdrawal queue
│       └── Dockerfile
│
├── apps/
│   ├── web/                  # Telegram Mini App (Next.js)
│   │   ├── src/
│   │   │   ├── pages/            # Next.js pages
│   │   │   │   ├── index.tsx         # Lobby / club selection
│   │   │   │   ├── table/[id].tsx    # Poker table view
│   │   │   │   └── wallet.tsx        # Balance / deposit / withdraw
│   │   │   ├── components/
│   │   │   │   ├── game/
│   │   │   │   │   └── PokerTable.tsx    # Main game UI
│   │   │   │   ├── club/
│   │   │   │   │   ├── ClubLobby.tsx
│   │   │   │   │   └── TableList.tsx
│   │   │   │   ├── wallet/
│   │   │   │   │   ├── BalanceCard.tsx
│   │   │   │   │   └── WithdrawModal.tsx
│   │   │   │   └── ui/
│   │   │   │       ├── Button.tsx
│   │   │   │       └── Modal.tsx
│   │   │   ├── stores/
│   │   │   │   ├── game.store.ts     # Zustand game state + socket
│   │   │   │   ├── auth.store.ts     # Auth + user state
│   │   │   │   └── wallet.store.ts   # Balance + tx history
│   │   │   ├── hooks/
│   │   │   │   ├── useTelegramTheme.ts
│   │   │   │   └── useApi.ts
│   │   │   └── lib/
│   │   │       ├── telegram.ts       # TWA SDK wrapper
│   │   │       └── api.ts            # API client (fetch wrapper)
│   │   └── package.json
│   │
│   └── admin/                # Club owner + platform admin dashboard (React)
│       └── src/
│           ├── pages/
│           │   ├── overview.tsx      # Platform overview
│           │   ├── clubs.tsx         # Club management
│           │   ├── players.tsx       # Player management
│           │   ├── hands.tsx         # Hand history audit
│           │   └── fraud.tsx         # Fraud signals
│           └── components/
│
├── infra/
│   ├── docker/
│   │   └── docker-compose.yml
│   ├── nginx/
│   │   └── nginx.conf
│   └── k8s/                  # Kubernetes manifests (later)
│       ├── api.yaml
│       ├── game-server.yaml
│       └── ingress.yaml
│
└── docs/
    ├── ARCHITECTURE.md
    ├── ROADMAP.md
    └── FOLDER_STRUCTURE.md
```

## Key Design Decisions

| Decision | Choice | Reason |
|---|---|---|
| State store | Redis | Sub-ms table state reads, crash recovery |
| Ledger design | Append-only | Audit trail, no financial mutations |
| Game authority | Server-only | Cheat prevention |
| Deck fairness | Hash commitment | Provably fair — seed revealed post-hand |
| Auth | Telegram HMAC + JWT | No passwords, frictionless |
| Scale | Horizontal (Redis adapter) | Game servers are stateless via Redis |
| Wallet ops | Single queue processor | Prevent double-sends |
| Rake | Atomic DB transaction | No partial rake distributions |
