import { Pool, PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';

export type TxType =
  | 'deposit'
  | 'withdrawal'
  | 'rake_club'
  | 'rake_platform'
  | 'transfer_in'
  | 'transfer_out'
  | 'bonus'
  | 'adjustment';

export interface LedgerEntry {
  userId: string;
  clubId: string | null;
  txType: TxType;
  amountTon: number;       // positive = credit, negative = debit
  referenceId?: string;
  referenceType?: string;
  idempotencyKey?: string;
  meta?: Record<string, unknown>;
}

export interface RakeDistribution {
  handId: string;
  tableId: string;
  clubId: string;
  totalRake: number;
  clubOwnerShare: number;   // TON amount
  platformShare: number;    // TON amount
  playerRakes: Array<{ userId: string; rakeAmount: number }>;
}

/**
 * LedgerService handles all financial operations.
 * All mutations go through here. All operations are atomic PostgreSQL transactions.
 * Balances are never mutated directly — always via ledger entries.
 */
export class LedgerService {
  constructor(private pool: Pool) {}

  /**
   * Credit or debit a user's balance atomically.
   * Uses advisory locks per user to prevent race conditions.
   */
  async recordEntry(client: PoolClient, entry: LedgerEntry): Promise<{ balanceAfter: number }> {
    const { userId, clubId, txType, amountTon, referenceId, referenceType, idempotencyKey, meta } = entry;

    // Idempotency check
    if (idempotencyKey) {
      const existing = await client.query(
        'SELECT id FROM ledger WHERE idempotency_key = $1',
        [idempotencyKey]
      );
      if (existing.rows.length > 0) {
        // Already processed — return current balance
        const bal = await client.query(
          'SELECT balance_ton FROM user_balances WHERE user_id = $1 AND club_id IS NOT DISTINCT FROM $2',
          [userId, clubId]
        );
        return { balanceAfter: parseFloat(bal.rows[0]?.balance_ton ?? '0') };
      }
    }

    // Upsert balance row (locked)
    await client.query(`
      INSERT INTO user_balances (user_id, club_id, balance_ton, locked_ton)
      VALUES ($1, $2, 0, 0)
      ON CONFLICT (user_id, COALESCE(club_id, '00000000-0000-0000-0000-000000000000'::UUID)) DO NOTHING
    `, [userId, clubId]);

    // Lock the balance row for this transaction
    const lockResult = await client.query(`
      SELECT balance_ton, locked_ton FROM user_balances
      WHERE user_id = $1 AND club_id IS NOT DISTINCT FROM $2
      FOR UPDATE
    `, [userId, clubId]);

    const currentBalance = parseFloat(lockResult.rows[0].balance_ton);
    const balanceAfter = currentBalance + amountTon;

    if (balanceAfter < 0) {
      throw new Error(`Insufficient balance: current=${currentBalance}, requested=${amountTon}`);
    }

    // Update balance
    await client.query(`
      UPDATE user_balances
      SET balance_ton = $1, updated_at = NOW()
      WHERE user_id = $2 AND club_id IS NOT DISTINCT FROM $3
    `, [balanceAfter, userId, clubId]);

    // Append ledger entry
    await client.query(`
      INSERT INTO ledger (user_id, club_id, tx_type, amount_ton, balance_after, reference_id, reference_type, idempotency_key, meta)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
    `, [userId, clubId, txType, amountTon, balanceAfter, referenceId, referenceType, idempotencyKey, JSON.stringify(meta ?? {})]);

    return { balanceAfter };
  }

  /**
   * Distribute rake from a completed hand.
   * Atomic: either all rake distributions succeed or none do.
   */
  async distributeRake(distribution: RakeDistribution): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const { handId, clubId, totalRake, clubOwnerShare, platformShare, playerRakes } = distribution;

      // Get club owner
      const clubResult = await client.query(
        'SELECT owner_id FROM clubs WHERE id = $1',
        [clubId]
      );
      const clubOwnerId = clubResult.rows[0]?.owner_id;
      if (!clubOwnerId) throw new Error(`Club not found: ${clubId}`);

      // Get platform config
      const platformResult = await client.query('SELECT * FROM platform_config WHERE id = 1');
      const platform = platformResult.rows[0];

      // Credit club owner
      await this.recordEntry(client, {
        userId: clubOwnerId,
        clubId: null, // platform-level balance
        txType: 'rake_club',
        amountTon: clubOwnerShare,
        referenceId: handId,
        referenceType: 'hand',
        idempotencyKey: `rake_club_${handId}`,
        meta: { hand_id: handId, club_id: clubId, total_rake: totalRake },
      });

      // Credit platform (no user balance — goes to treasury wallet via separate process)
      // We record it in a system ledger entry for the platform wallet
      await client.query(`
        INSERT INTO ledger (user_id, club_id, tx_type, amount_ton, balance_after, reference_id, reference_type, idempotency_key, meta)
        SELECT owner_id, NULL, 'rake_platform', $1, 0, $2, 'hand', $3, $4
        FROM clubs WHERE id = 'platform'
      `, [platformShare, handId, `rake_platform_${handId}`, JSON.stringify({ hand_id: handId })]);
      // Note: platform rake is swept to treasury wallet by wallet service

      // Record agent commissions
      for (const { userId, rakeAmount } of playerRakes) {
        const agentResult = await client.query(`
          SELECT cm.agent_id, ac.commission_pct
          FROM club_members cm
          JOIN agent_configs ac ON ac.agent_id = cm.agent_id AND ac.club_id = $1
          WHERE cm.user_id = $2 AND cm.club_id = $1 AND cm.agent_id IS NOT NULL
        `, [clubId, userId]);

        if (agentResult.rows.length > 0) {
          const { agent_id, commission_pct } = agentResult.rows[0];
          const commission = rakeAmount * parseFloat(commission_pct);

          await this.recordEntry(client, {
            userId: agent_id,
            clubId: null,
            txType: 'bonus',
            amountTon: commission,
            referenceId: handId,
            referenceType: 'hand',
            idempotencyKey: `agent_comm_${handId}_${agent_id}`,
            meta: { type: 'agent_commission', player_id: userId },
          });

          await client.query(`
            INSERT INTO agent_earnings (agent_id, club_id, player_id, hand_id, player_rake, commission)
            VALUES ($1, $2, $3, $4, $5, $6)
          `, [agent_id, clubId, userId, handId, rakeAmount, commission]);
        }
      }

      // Update hand rake totals
      await client.query(`
        UPDATE hands
        SET rake_total = $1, rake_club = $2, rake_platform = $3
        WHERE id = $4
      `, [totalRake, clubOwnerShare, platformShare, handId]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Lock chips when player sits at table.
   */
  async lockChips(userId: string, clubId: string, amount: number, tableId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      const result = await client.query(`
        SELECT balance_ton, locked_ton FROM user_balances
        WHERE user_id = $1 AND club_id = $2
        FOR UPDATE
      `, [userId, clubId]);

      if (!result.rows.length) throw new Error('No balance found');

      const balance = parseFloat(result.rows[0].balance_ton);
      const locked = parseFloat(result.rows[0].locked_ton);

      if (balance - locked < amount) throw new Error('Insufficient available balance');

      await client.query(`
        UPDATE user_balances
        SET locked_ton = locked_ton + $1, updated_at = NOW()
        WHERE user_id = $2 AND club_id = $3
      `, [amount, userId, clubId]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * Settle chips when player leaves table.
   * net_change = final_stack - initial_buy_in (can be positive or negative)
   */
  async settleTableSession(
    userId: string,
    clubId: string,
    lockedAmount: number,
    finalStack: number,
    tableId: string
  ): Promise<void> {
    const netChange = finalStack - lockedAmount;
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        UPDATE user_balances
        SET balance_ton = balance_ton + $1,
            locked_ton = locked_ton - $2,
            updated_at = NOW()
        WHERE user_id = $3 AND club_id = $4
      `, [netChange, lockedAmount, userId, clubId]);

      await this.recordEntry(client, {
        userId,
        clubId,
        txType: netChange >= 0 ? 'transfer_in' : 'transfer_out',
        amountTon: netChange,
        referenceId: tableId,
        referenceType: 'table_session',
        meta: { locked: lockedAmount, final: finalStack },
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getBalance(userId: string, clubId: string | null): Promise<number> {
    const result = await this.pool.query(`
      SELECT balance_ton - locked_ton AS available
      FROM user_balances
      WHERE user_id = $1 AND club_id IS NOT DISTINCT FROM $2
    `, [userId, clubId]);
    return parseFloat(result.rows[0]?.available ?? '0');
  }
}
