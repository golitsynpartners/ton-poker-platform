import { useEffect } from 'react';
import { useRouter } from 'next/router';
import dynamic from 'next/dynamic';
import { useGameStore } from '../../stores/game.store';

// Import game table without SSR (uses browser APIs)
const PokerTable = dynamic(
  () => import('../../components/game/PokerTable').then(m => m.PokerTable),
  { ssr: false, loading: () => (
    <div className="flex items-center justify-center min-h-screen bg-gray-950">
      <div className="w-10 h-10 border-4 border-yellow-400 border-t-transparent rounded-full animate-spin" />
    </div>
  )}
);

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? 'http://localhost:3002';

export default function TablePage() {
  const router = useRouter();
  const { id, clubId, buyIn } = router.query;
  const { connect, joinTable, disconnect, connected } = useGameStore();

  const token = typeof window !== 'undefined' ? localStorage.getItem('token') : null;
  const tgUser = typeof window !== 'undefined' ? window.Telegram?.WebApp?.initDataUnsafe?.user : null;
  const myUserId = token ? JSON.parse(atob(token.split('.')[1])).userId : '';

  useEffect(() => {
    if (!id || !token) return;

    connect(token, WS_URL);

    return () => { disconnect(); };
  }, [id, token, connect, disconnect]);

  useEffect(() => {
    if (!connected || !id || !buyIn) return;
    joinTable(id as string, parseFloat(buyIn as string));
  }, [connected, id, buyIn, joinTable]);

  // Handle back button
  useEffect(() => {
    const twa = window.Telegram?.WebApp;
    if (!twa) return;
    twa.BackButton.show();
    twa.BackButton.onClick(() => {
      window.Telegram?.WebApp?.showConfirm(
        'Leave the table? Your chips will be returned to your balance.',
        (ok) => { if (ok) { disconnect(); router.back(); } }
      );
    });
    return () => { twa.BackButton.hide(); };
  }, [disconnect, router]);

  if (!myUserId) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-gray-950 text-white">
        <p>Not authenticated</p>
      </div>
    );
  }

  return <PokerTable myUserId={myUserId} />;
}
