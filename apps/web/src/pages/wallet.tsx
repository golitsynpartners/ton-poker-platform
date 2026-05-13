import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

export default function WalletPage() {
  const router = useRouter();
  const [balances, setBalances] = useState<any[]>([]);
  const [depositInfo, setDepositInfo] = useState<{ address: string; memo: string; minAmount: number } | null>(null);
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [withdrawAddr, setWithdrawAddr] = useState('');
  const [tab, setTab] = useState<'balance' | 'deposit' | 'withdraw'>('balance');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : '';

  useEffect(() => {
    if (!token) { router.push('/'); return; }
    const load = async () => {
      try {
        const [balRes, depRes] = await Promise.all([
          fetch(`${API}/api/v1/wallet/balances`, { headers: { Authorization: `Bearer ${token}` } }),
          fetch(`${API}/api/v1/wallet/deposit-info`, { headers: { Authorization: `Bearer ${token}` } }),
        ]);
        setBalances((await balRes.json()).balances ?? []);
        setDepositInfo(await depRes.json());
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [token, router]);

  const copyToClipboard = (text: string, label: string) => {
    navigator.clipboard.writeText(text);
    window.Telegram?.WebApp?.showAlert(`${label} copied!`);
  };

  const submitWithdrawal = async () => {
    if (!withdrawAmount || !withdrawAddr) return;
    setSubmitting(true);
    try {
      const res = await fetch(`${API}/api/v1/wallet/withdraw`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ amountTon: parseFloat(withdrawAmount), toAddress: withdrawAddr }),
      });
      const data = await res.json();
      if (!res.ok) { window.Telegram?.WebApp?.showAlert(data.error); return; }
      window.Telegram?.WebApp?.showAlert(data.message);
      setWithdrawAmount(''); setWithdrawAddr('');
    } finally {
      setSubmitting(false);
    }
  };

  const totalBalance = balances.reduce((s, b) => s + (b.available ?? 0), 0);

  return (
    <div className="min-h-screen bg-felt-dark flex flex-col">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 pt-4 pb-3 safe-area-pt">
        <button onClick={() => router.back()} className="text-gray-400 text-xl">←</button>
        <h1 className="text-white text-lg font-bold">My Wallet</h1>
      </div>

      {/* Total */}
      <div className="mx-4 mb-4 bg-gradient-to-br from-yellow-600/30 to-yellow-900/20 border border-yellow-700/40 rounded-2xl p-5 text-center">
        <p className="text-gray-400 text-xs mb-1">TOTAL BALANCE</p>
        <p className="text-white text-3xl font-bold">{totalBalance.toFixed(4)}</p>
        <p className="text-yellow-400 text-sm">TON</p>
      </div>

      {/* Tabs */}
      <div className="flex mx-4 mb-4 bg-black/30 rounded-xl p-1">
        {(['balance', 'deposit', 'withdraw'] as const).map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 text-xs font-medium rounded-lg transition-all ${
              tab === t ? 'bg-yellow-500 text-black' : 'text-gray-400'
            }`}
          >
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      <div className="flex-1 px-4">
        {/* Balance tab */}
        {tab === 'balance' && (
          <div className="flex flex-col gap-2">
            {loading ? (
              <div className="text-center py-8 text-gray-500">Loading...</div>
            ) : balances.length === 0 ? (
              <p className="text-gray-500 text-sm text-center py-8">No balances yet — deposit TON to get started</p>
            ) : (
              balances.map((b, i) => (
                <div key={i} className="bg-black/40 rounded-xl p-4 flex justify-between items-center">
                  <div>
                    <p className="text-white font-medium text-sm">{b.clubName}</p>
                    {b.locked > 0 && <p className="text-gray-500 text-xs">{b.locked.toFixed(4)} locked at table</p>}
                  </div>
                  <p className="text-yellow-400 font-bold">{b.available.toFixed(4)} TON</p>
                </div>
              ))
            )}
          </div>
        )}

        {/* Deposit tab */}
        {tab === 'deposit' && depositInfo && (
          <div className="flex flex-col gap-4">
            <div className="bg-black/40 rounded-2xl p-4">
              <p className="text-gray-400 text-xs mb-3">Send TON to this address with the memo below</p>

              <div className="mb-4">
                <p className="text-gray-500 text-xs mb-1">DEPOSIT ADDRESS</p>
                <div className="flex items-center gap-2 bg-black/60 rounded-xl p-3">
                  <p className="text-white text-xs flex-1 break-all font-mono">{depositInfo.address}</p>
                  <button onClick={() => copyToClipboard(depositInfo.address, 'Address')} className="text-yellow-400 text-xs shrink-0">Copy</button>
                </div>
              </div>

              <div className="mb-4">
                <p className="text-gray-500 text-xs mb-1">YOUR MEMO (required)</p>
                <div className="flex items-center gap-2 bg-black/60 rounded-xl p-3">
                  <p className="text-white font-mono text-xl font-bold flex-1 tracking-widest">{depositInfo.memo}</p>
                  <button onClick={() => copyToClipboard(depositInfo.memo, 'Memo')} className="text-yellow-400 text-xs shrink-0">Copy</button>
                </div>
              </div>

              <div className="bg-red-900/30 border border-red-800/40 rounded-xl p-3">
                <p className="text-red-300 text-xs font-medium">⚠️ Include your memo in every deposit</p>
                <p className="text-red-400/70 text-xs mt-1">Without the memo we cannot identify your payment</p>
              </div>

              <p className="text-gray-500 text-xs mt-3">Minimum deposit: {depositInfo.minAmount} TON</p>
            </div>
          </div>
        )}

        {/* Withdraw tab */}
        {tab === 'withdraw' && (
          <div className="flex flex-col gap-4">
            <div className="bg-black/40 rounded-2xl p-4 flex flex-col gap-4">
              <div>
                <label className="text-gray-400 text-xs block mb-1.5">AMOUNT (TON)</label>
                <input
                  type="number"
                  value={withdrawAmount}
                  onChange={e => setWithdrawAmount(e.target.value)}
                  placeholder="0.00"
                  step="0.1"
                  min="0.5"
                  className="w-full bg-black/60 text-white rounded-xl px-4 py-3 border border-gray-700 focus:border-yellow-500 outline-none text-lg font-bold"
                />
                <p className="text-gray-600 text-xs mt-1">Available: {totalBalance.toFixed(4)} TON · Min: 0.5 TON</p>
              </div>

              <div>
                <label className="text-gray-400 text-xs block mb-1.5">TON WALLET ADDRESS</label>
                <input
                  type="text"
                  value={withdrawAddr}
                  onChange={e => setWithdrawAddr(e.target.value)}
                  placeholder="EQD..."
                  className="w-full bg-black/60 text-white rounded-xl px-4 py-3 border border-gray-700 focus:border-yellow-500 outline-none font-mono text-sm"
                />
              </div>

              <button
                onClick={submitWithdrawal}
                disabled={submitting || !withdrawAmount || !withdrawAddr || parseFloat(withdrawAmount) < 0.5}
                className="w-full py-3.5 bg-yellow-500 text-black font-bold rounded-xl disabled:opacity-40 active:scale-[0.98] transition-all"
              >
                {submitting ? 'Submitting...' : 'Withdraw TON'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
