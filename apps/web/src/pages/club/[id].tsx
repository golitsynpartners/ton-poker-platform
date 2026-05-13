import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Table {
  id: string;
  name: string;
  small_blind: string;
  big_blind: string;
  min_buy_in: string;
  max_buy_in: string;
  max_seats: number;
  status: string;
  seat_count?: number;
}

export default function ClubPage() {
  const router = useRouter();
  const { id } = router.query;
  const [tables, setTables] = useState<Table[]>([]);
  const [loading, setLoading] = useState(true);
  const [balance, setBalance] = useState(0);

  useEffect(() => {
    if (!id) return;
    const token = localStorage.getItem('token');
    if (!token) { router.push('/'); return; }

    const load = async () => {
      try {
        const [tablesRes, balRes] = await Promise.all([
          fetch(`${API}/api/v1/clubs/${id}/tables`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API}/api/v1/wallet/balances`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        const tablesData = await tablesRes.json();
        const balData = await balRes.json();

        setTables(tablesData.tables ?? []);
        const clubBal = balData.balances?.find((b: any) => b.clubId === id);
        setBalance(clubBal?.available ?? 0);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [id, router]);

  const joinTable = (table: Table) => {
    if (balance < parseFloat(table.min_buy_in)) {
      window.Telegram?.WebApp?.showAlert(`Need at least ${table.min_buy_in} TON to join this table`);
      return;
    }
    router.push(`/table/${table.id}?clubId=${id}&buyIn=${table.min_buy_in}`);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-felt-dark">
        <div className="w-10 h-10 border-4 border-yellow-400 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-felt-dark flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 safe-area-pt">
        <button onClick={() => router.back()} className="text-gray-400 text-lg">←</button>
        <div className="flex-1">
          <h1 className="text-white font-bold">Club Tables</h1>
          <p className="text-yellow-400 text-xs">Balance: {balance.toFixed(2)} TON</p>
        </div>
        <button
          onClick={() => router.push('/wallet')}
          className="text-xs text-green-400 border border-green-700 px-3 py-1 rounded-lg"
        >
          Deposit
        </button>
      </div>

      {/* Tables */}
      <div className="flex-1 px-4 py-2">
        {tables.length === 0 ? (
          <div className="text-center py-16">
            <div className="text-5xl mb-3">🎰</div>
            <p className="text-gray-400">No tables open right now</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {tables.map(table => {
              const sb = parseFloat(table.small_blind);
              const bb = parseFloat(table.big_blind);
              const canJoin = balance >= parseFloat(table.min_buy_in);
              return (
                <div key={table.id} className="bg-black/40 border border-gray-800 rounded-2xl p-4">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <p className="text-white font-bold">{table.name}</p>
                      <p className="text-gray-400 text-xs mt-0.5">
                        Blinds: {sb}/{bb} TON
                      </p>
                    </div>
                    <div className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                      table.status === 'active' ? 'bg-green-900 text-green-300' : 'bg-gray-800 text-gray-400'
                    }`}>
                      {table.status === 'active' ? '● Live' : 'Waiting'}
                    </div>
                  </div>

                  <div className="flex gap-4 text-xs text-gray-500 mb-3">
                    <span>Min: {parseFloat(table.min_buy_in)} TON</span>
                    <span>Max: {parseFloat(table.max_buy_in)} TON</span>
                    <span>{table.seat_count ?? 0}/{table.max_seats} seats</span>
                  </div>

                  <button
                    onClick={() => joinTable(table)}
                    disabled={!canJoin}
                    className={`w-full py-2.5 rounded-xl text-sm font-bold transition-all active:scale-[0.98] ${
                      canJoin
                        ? 'bg-green-600 hover:bg-green-500 text-white'
                        : 'bg-gray-800 text-gray-600 cursor-not-allowed'
                    }`}
                  >
                    {canJoin ? 'Sit Down' : `Need ${parseFloat(table.min_buy_in)} TON`}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
