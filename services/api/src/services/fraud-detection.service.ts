import { Pool } from 'pg';

/**
 * FraudDetectionService runs heuristic and statistical checks on game data.
 *
 * Runs async after each hand completes — never blocks gameplay.
 * Creates fraud_signals records for human review.
 */
export class FraudDetectionService {
  constructor(private db: Pool) {}

  async analyzeHand(handId: string): Promise<void> {
    await Promise.allSettled([
      this.checkCollusionSignals(handId),
      this.checkUnusualWinRate(handId),
      this.checkRapidFolding(handId),
    ]);
  }

  /**
   * Collusion detection: two players at the same table repeatedly,
   * one always folding to the other. Check for correlated behavior.
   */
  private async checkCollusionSignals(handId: string): Promise<void> {
    const result = await this.db.query(`
      WITH hand_info AS (
        SELECT table_id FROM hands WHERE id = $1
      ),
      player_pairs AS (
        SELECT
          hp1.user_id as player_a,
          hp2.user_id as player_b,
          COUNT(*) as shared_hands,
          SUM(CASE WHEN hp1.is_winner AND NOT hp2.is_winner THEN 1 ELSE 0 END) as a_wins_b_loses,
          SUM(CASE WHEN hp2.is_winner AND NOT hp1.is_winner THEN 1 ELSE 0 END) as b_wins_a_loses
        FROM hand_players hp1
        JOIN hand_players hp2 ON hp2.hand_id = hp1.hand_id AND hp2.user_id > hp1.user_id
        JOIN hands h ON h.id = hp1.hand_id
        WHERE h.table_id = (SELECT table_id FROM hand_info)
          AND h.started_at >= NOW() - INTERVAL '2 hours'
        GROUP BY hp1.user_id, hp2.user_id
        HAVING COUNT(*) >= 10
      )
      SELECT *,
        GREATEST(a_wins_b_loses, b_wins_a_loses)::float / NULLIF(shared_hands, 0) as win_dominance
      FROM player_pairs
      WHERE GREATEST(a_wins_b_loses, b_wins_a_loses)::float / NULLIF(shared_hands, 0) > 0.85
    `, [handId]);

    for (const row of result.rows) {
      await this.createSignal({
        userId: row.player_a,
        signalType: 'collusion_suspect',
        severity: 'high',
        details: {
          partner: row.player_b,
          shared_hands: row.shared_hands,
          win_dominance: row.win_dominance,
          hand_id: handId,
        },
      });
    }
  }

  /**
   * Statistical win rate analysis.
   * A player winning >65% of contested hands over 100+ hands is statistically anomalous.
   */
  private async checkUnusualWinRate(handId: string): Promise<void> {
    const result = await this.db.query(`
      SELECT
        user_id,
        COUNT(*) as total_hands,
        SUM(CASE WHEN is_winner THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN is_winner THEN 1 ELSE 0 END)::float / COUNT(*) as win_rate,
        AVG(amount_won - amount_wagered) as avg_profit
      FROM hand_players
      WHERE hand_id IN (
        SELECT id FROM hands WHERE started_at >= NOW() - INTERVAL '24 hours'
      )
      GROUP BY user_id
      HAVING COUNT(*) >= 50
        AND SUM(CASE WHEN is_winner THEN 1 ELSE 0 END)::float / COUNT(*) > 0.65
    `);

    for (const row of result.rows) {
      await this.createSignal({
        userId: row.user_id,
        signalType: 'unusual_win_rate',
        severity: 'medium',
        details: {
          win_rate: row.win_rate,
          total_hands: row.total_hands,
          avg_profit: row.avg_profit,
        },
      });
    }
  }

  /**
   * Rapid folding pattern: a player folding immediately on every turn
   * suggests timeout farming or automated play.
   */
  private async checkRapidFolding(handId: string): Promise<void> {
    const result = await this.db.query(`
      SELECT
        user_id,
        COUNT(*) as total_actions,
        SUM(CASE WHEN action = 'fold' AND time_taken_ms < 1000 THEN 1 ELSE 0 END) as rapid_folds,
        SUM(CASE WHEN action = 'fold' AND time_taken_ms < 1000 THEN 1 ELSE 0 END)::float / COUNT(*) as rapid_fold_rate
      FROM hand_actions
      WHERE hand_id IN (
        SELECT id FROM hands WHERE started_at >= NOW() - INTERVAL '1 hour'
      )
      GROUP BY user_id
      HAVING COUNT(*) >= 20
        AND SUM(CASE WHEN action = 'fold' AND time_taken_ms < 1000 THEN 1 ELSE 0 END)::float / COUNT(*) > 0.9
    `);

    for (const row of result.rows) {
      await this.createSignal({
        userId: row.user_id,
        signalType: 'automated_play_suspect',
        severity: 'medium',
        details: {
          rapid_fold_rate: row.rapid_fold_rate,
          total_actions: row.total_actions,
        },
      });
    }
  }

  private async createSignal(params: {
    userId: string;
    signalType: string;
    severity: 'low' | 'medium' | 'high';
    details: Record<string, unknown>;
  }): Promise<void> {
    // Deduplicate: don't create same signal type for same user within 1 hour
    const existing = await this.db.query(`
      SELECT 1 FROM fraud_signals
      WHERE user_id = $1 AND signal_type = $2 AND created_at >= NOW() - INTERVAL '1 hour'
    `, [params.userId, params.signalType]);

    if (existing.rows.length) return;

    await this.db.query(`
      INSERT INTO fraud_signals (user_id, signal_type, severity, details)
      VALUES ($1, $2, $3, $4)
    `, [params.userId, params.signalType, params.severity, JSON.stringify(params.details)]);
  }
}
