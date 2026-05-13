import { useEffect, useState } from 'react';
import { useRouter } from 'next/router';

const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';

interface Club {
  id: string;
  name: string;
  member_count: number;
  table_count: number;
  balance_ton: string;
}

export default function Home() {
  const router = useRouter();
  const [clubs, setClubs] = useState<Club[]>([]);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState('');
  const [inviteCode, setInviteCode] = useState('');
  const [joining, setJoining] = useState(false);
  const [user, setUser] = useState<any>(null);

  useEffect(() => {
    const init = async () => {
      const twa = window.Telegram?.WebApp;
      const initData = twa?.initData ?? '';

      if (!initData && process.env.NODE_ENV === 'development') {
        // Dev mode: show placeholder UI
        setLoading(false);
        return;
      }

      try {
        const res = await fetch(`${API}/api/v1/auth/telegram`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ initData }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        setToken(data.token);
        setUser(twa?.initDataUnsafe?.user);
        localStorage.setItem('token', data.token);

        // Load clubs
        const clubsRes = await fetch(`${API}/api/v1/clubs/mine`, {
          headers: { Authorization: `Bearer ${data.token}` },
        });
        const clubsData = await clubsRes.json();
        setClubs(clubsData.clubs ?? []);
      } catch (err) {
        console.error('Init failed:', err);
      } finally {
        setLoading(false);
      }
    };
    init();
  }, []);

  const joinClub = async () => {
    if (!inviteCode.trim() || !token) return;
    setJoining(true);
    try {
      const res = await fetch(`${API}/api/v1/clubs/join`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ inviteCode: inviteCode.trim().toUpperCase() }),
      });
      const data = await res.json();
      if (!res.ok) {
        window.Telegram?.WebApp?.showAlert(data.error);
        return;
      }
      window.Telegram?.WebApp?.showAlert(`Joined ${data.club.name}!`);
      setInviteCode('');
      // Refresh clubs
      const clubsRes = await fetch(`${API}/api/v1/clubs/mine`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      setClubs((await clubsRes.json()).clubs ?? []);
    } finally {
      setJoining(false);
    }
  };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-felt-dark">
        <div className="w-12 h-12 border-4 border-yellow-400 border-t-transparent rounded-full animate-spin" />
        <p className="text-gray-300 mt-4 text-sm">Loading...</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-felt-dark flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-4 pb-3 safe-area-pt">
        <div>
          <h1 className="text-white text-xl font-bold">♠ TON Poker</h1>
          {user && <p className="text-green-300 text-xs">Hi, {user.first_name}</p>}
        </div>
        <button
          onClick={() => router.push('/wallet')}
          className="bg-yellow-500 text-black text-sm font-bold px-3 py-1.5 rounded-xl"
        >
          💎 Wallet
        </button>
      </div>

      {/* Join club */}
      <div className="mx-4 mb-4 bg-black/30 rounded-2xl p-4">
        <p className="text-gray-300 text-xs mb-2 font-medium">JOIN A CLUB</p>
        <div className="flex gap-2">
          <input
            value={inviteCode}
            onChange={e => setInviteCode(e.target.value.toUpperCase())}
            placeholder="Enter invite code"
            maxLength={12}
            className="flex-1 bg-black/40 text-white text-sm rounded-xl px-3 py-2 border border-gray-700 focus:border-yellow-500 outline-none placeholder-gray-600 tracking-widest"
          />
          <button
            onClick={joinClub}
            disabled={joining || !inviteCode.trim()}
            className="bg-green-600 text-white text-sm font-bold px-4 rounded-xl disabled:opacity-40 active:scale-95 transition-all"
          >
            {joining ? '...' : 'Join'}
          </button>
        </div>
      </div>

      {/* Clubs list */}
      <div className="flex-1 px-4">
        <p className="text-gray-400 text-xs font-medium mb-3">MY CLUBS</p>

        {clubs.length === 0 ? (
          <div className="text-center py-12">
            <div className="text-5xl mb-3">🃏</div>
            <p className="text-gray-400 text-sm">No clubs yet</p>
            <p className="text-gray-600 text-xs mt-1">Enter an invite code to join one</p>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {clubs.map(club => (
              <button
                key={club.id}
                onClick={() => router.push(`/club/${club.id}`)}
                className="w-full bg-black/40 border border-gray-800 rounded-2xl p-4 text-left active:scale-[0.98] transition-all"
              >
                <div className="flex justify-between items-start">
                  <div>
                    <p className="text-white font-bold">{club.name}</p>
                    <p className="text-gray-500 text-xs mt-0.5">
                      {club.member_count} players · {club.table_count} tables
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-yellow-400 font-bold text-sm">
                      {parseFloat(club.balance_ton ?? '0').toFixed(2)} TON
                    </p>
                    <p className="text-gray-600 text-xs">balance</p>
                  </div>
                </div>
                <div className="mt-3 flex items-center text-green-400 text-xs font-medium">
                  Play now →
                </div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
