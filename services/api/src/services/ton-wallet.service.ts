import { TonClient, WalletContractV4, internal, Address, toNano, fromNano, Cell, beginCell } from '@ton/ton';
import { mnemonicToPrivateKey } from '@ton/crypto';
import { createClient } from 'redis';
import { Pool } from 'pg';

export interface DepositMonitorConfig {
  platformWallet: string;
  rpcUrl: string;
  apiKey: string;
  pollIntervalMs: number;
}

export interface WithdrawalRequest {
  id: string;
  toAddress: string;
  amountTon: number;
  userId: string;
}

/**
 * TonWalletService manages all blockchain interactions.
 *
 * Architecture:
 * - Deposits: Monitor platform wallet for incoming txs, credit user balances
 * - Withdrawals: Queue-based, sweep from platform wallet to user wallets
 * - Idempotency: All tx processing is idempotent via ton_hash unique index
 */
export class TonWalletService {
  private client: TonClient;
  private redis: ReturnType<typeof createClient>;
  private db: Pool;
  private config: DepositMonitorConfig;
  private isMonitoring = false;
  private lastLt: bigint | null = null; // TON logical time cursor

  constructor(
    client: TonClient,
    redis: ReturnType<typeof createClient>,
    db: Pool,
    config: DepositMonitorConfig
  ) {
    this.client = client;
    this.redis = redis;
    this.db = db;
    this.config = config;
  }

  /**
   * Generate a unique deposit memo for a user.
   * Players send TON with this memo so we can attribute the deposit.
   *
   * Alternative: generate unique subaddresses per user (more complex, more private).
   */
  generateDepositMemo(userId: string): string {
    // 8-char alphanumeric derived from userId prefix
    return userId.replace(/-/g, '').substring(0, 8).toUpperCase();
  }

  /**
   * Get the deposit address and memo for a user.
   */
  getDepositInfo(userId: string): { address: string; memo: string; minAmount: number } {
    return {
      address: this.config.platformWallet,
      memo: this.generateDepositMemo(userId),
      minAmount: 1.0, // minimum deposit in TON
    };
  }

  /**
   * Start monitoring the platform wallet for incoming deposits.
   * Runs as a background polling loop.
   * In production: use TON webhook or dedicated indexer (Toncenter webhooks).
   */
  async startDepositMonitor(): Promise<void> {
    if (this.isMonitoring) return;
    this.isMonitoring = true;

    // Restore cursor from Redis
    const savedLt = await this.redis.get('ton:deposit_cursor');
    if (savedLt) this.lastLt = BigInt(savedLt);

    console.log(`[TON Monitor] Starting. Last LT: ${this.lastLt}`);

    const poll = async () => {
      try {
        await this.checkForDeposits();
      } catch (err) {
        console.error('[TON Monitor] Poll error:', err);
      }

      if (this.isMonitoring) {
        setTimeout(poll, this.config.pollIntervalMs);
      }
    };

    poll();
  }

  private async checkForDeposits(): Promise<void> {
    const address = Address.parse(this.config.platformWallet);
    const transactions = await this.client.getTransactions(address, {
      limit: 20,
      lt: this.lastLt?.toString(),
    });

    if (!transactions.length) return;

    for (const tx of transactions) {
      await this.processInboundTransaction(tx);
    }

    // Advance cursor
    const latestLt = transactions[0].lt;
    this.lastLt = latestLt;
    await this.redis.set('ton:deposit_cursor', latestLt.toString());
  }

  private async processInboundTransaction(tx: any): Promise<void> {
    const txHash = tx.hash().toString('hex');

    // Idempotency check — skip already-processed transactions
    const existing = await this.db.query(
      'SELECT id FROM ton_transactions WHERE ton_hash = $1',
      [txHash]
    );
    if (existing.rows.length > 0) return;

    // Only process incoming (from external to platform wallet)
    if (!tx.inMessage) return;

    const amountNano = tx.inMessage.info.value?.coins;
    if (!amountNano || amountNano < toNano('1')) return; // below minimum

    const amountTon = parseFloat(fromNano(amountNano));
    const senderAddress = tx.inMessage.info.src?.toString();
    const memo = this.extractMemo(tx.inMessage);

    if (!memo) {
      console.warn(`[TON Monitor] Tx ${txHash} has no memo — cannot attribute to user`);
      return; // Log and alert, refund logic here
    }

    // Find user by memo
    const userResult = await this.db.query(`
      SELECT id FROM users
      WHERE encode(uuid_send(id::uuid), 'hex') LIKE $1 || '%'
         OR id::text REPLACE '-', '' LIKE $1 || '%'
    `, [memo.toLowerCase()]);

    // Alternative: maintain a memo→userId lookup table
    const userId = userResult.rows[0]?.id;
    if (!userId) {
      console.warn(`[TON Monitor] No user found for memo: ${memo}`);
      return;
    }

    // Record the TON transaction
    const tonTxResult = await this.db.query(`
      INSERT INTO ton_transactions (user_id, tx_type, status, amount_ton, ton_hash, from_address, to_address, confirmations, required_confirmations, block_lt)
      VALUES ($1, 'deposit', 'confirmed', $2, $3, $4, $5, 1, 1, $6)
      RETURNING id
    `, [userId, amountTon, txHash, senderAddress, this.config.platformWallet, tx.lt.toString()]);

    const tonTxId = tonTxResult.rows[0].id;

    // Credit user balance (idempotent via idempotency key)
    const idempotencyKey = `deposit_${txHash}`;
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        INSERT INTO user_balances (user_id, club_id, balance_ton, locked_ton)
        VALUES ($1, NULL, 0, 0)
        ON CONFLICT DO NOTHING
      `, [userId]);

      await client.query(`
        UPDATE user_balances SET balance_ton = balance_ton + $1, updated_at = NOW()
        WHERE user_id = $2 AND club_id IS NULL
      `, [amountTon, userId]);

      await client.query(`
        INSERT INTO ledger (user_id, club_id, tx_type, amount_ton, balance_after, reference_id, reference_type, idempotency_key)
        SELECT $1, NULL, 'deposit', $2, balance_ton, $3, 'ton_transaction', $4
        FROM user_balances WHERE user_id = $1 AND club_id IS NULL
      `, [userId, amountTon, tonTxId, idempotencyKey]);

      await client.query('COMMIT');
      console.log(`[TON Monitor] Credited ${amountTon} TON to user ${userId} (tx: ${txHash})`);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  private extractMemo(message: any): string | null {
    try {
      const body = message.body;
      if (!body) return null;
      const slice = body.beginParse();
      const op = slice.loadUint(32);
      if (op === 0) {
        // text comment
        return slice.loadStringTail();
      }
      return null;
    } catch {
      return null;
    }
  }

  /**
   * Execute a withdrawal. Called by the withdrawal processor queue.
   * Requires platform wallet mnemonic (stored in secrets manager, never in DB).
   */
  async executeWithdrawal(
    withdrawal: WithdrawalRequest,
    mnemonic: string[]
  ): Promise<string> {
    const keyPair = await mnemonicToPrivateKey(mnemonic);
    const wallet = WalletContractV4.create({ publicKey: keyPair.publicKey, workchain: 0 });
    const contract = this.client.open(wallet);

    const seqno = await contract.getSeqno();

    await contract.sendTransfer({
      secretKey: keyPair.secretKey,
      seqno,
      messages: [
        internal({
          to: Address.parse(withdrawal.toAddress),
          value: toNano(withdrawal.amountTon.toFixed(9)),
          comment: `Withdrawal ${withdrawal.id.substring(0, 8)}`,
        }),
      ],
    });

    // Wait for tx to appear on chain
    await this.waitForSeqno(contract, seqno);

    // Get the tx hash for the outbound transfer
    const txs = await this.client.getTransactions(wallet.address, { limit: 5 });
    const outTx = txs.find(tx => tx.outMessages.size > 0);
    return outTx?.hash().toString('hex') ?? 'unknown';
  }

  private async waitForSeqno(contract: any, seqno: number): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const current = await contract.getSeqno();
      if (current > seqno) return;
    }
    throw new Error('Transaction not confirmed within timeout');
  }
}
