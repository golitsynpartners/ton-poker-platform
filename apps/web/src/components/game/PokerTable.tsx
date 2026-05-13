import React, { useState } from 'react';
import { useGameStore, TableSeat } from '../../stores/game.store';
import { hapticImpact, hapticNotification } from '../../lib/telegram';

// ─── Card Component ──────────────────────────────────────────────────────────

const SUIT_SYMBOLS = { S: '♠', H: '♥', D: '♦', C: '♣' };
const SUIT_COLORS = { S: 'text-gray-900', H: 'text-red-600', D: 'text-red-600', C: 'text-gray-900' };
const RANK_DISPLAY: Record<string, string> = { T: '10', J: 'J', Q: 'Q', K: 'K', A: 'A' };

function PlayingCard({ card, faceDown = false }: { card: string; faceDown?: boolean }) {
  if (faceDown) {
    return (
      <div className="w-10 h-14 bg-blue-800 rounded-md border-2 border-blue-600 flex items-center justify-center shadow-md">
        <div className="w-7 h-11 border border-blue-500 rounded" />
      </div>
    );
  }

  const rank = card[0];
  const suit = card[1] as keyof typeof SUIT_SYMBOLS;
  const displayRank = RANK_DISPLAY[rank] ?? rank;

  return (
    <div className="w-10 h-14 bg-white rounded-md border border-gray-300 flex flex-col p-1 shadow-md select-none">
      <span className={`text-xs font-bold leading-none ${SUIT_COLORS[suit]}`}>{displayRank}</span>
      <span className={`text-xs leading-none ${SUIT_COLORS[suit]}`}>{SUIT_SYMBOLS[suit]}</span>
      <span className={`text-base leading-none text-center mt-auto ${SUIT_COLORS[suit]}`}>{SUIT_SYMBOLS[suit]}</span>
    </div>
  );
}

// ─── Player Seat ─────────────────────────────────────────────────────────────

function PlayerSeat({
  seat,
  myUserId,
  isActing,
  myCards,
  showdownCards,
}: {
  seat: TableSeat;
  myUserId: string;
  isActing: boolean;
  myCards: [string, string] | null;
  showdownCards: Map<string, [string, string]>;
}) {
  const isMe = seat.userId === myUserId;
  const cards = isMe ? myCards : (showdownCards.get(seat.userId) ?? null);

  return (
    <div className={`
      flex flex-col items-center gap-1 p-2 rounded-xl min-w-[72px]
      transition-all duration-200
      ${isActing ? 'ring-2 ring-yellow-400 bg-yellow-400/10' : 'bg-black/40'}
      ${seat.isFolded ? 'opacity-40' : ''}
      ${seat.isSittingOut ? 'opacity-60' : ''}
    `}>
      {/* Cards */}
      <div className="flex gap-0.5">
        {cards ? (
          <>
            <PlayingCard card={cards[0]} />
            <PlayingCard card={cards[1]} />
          </>
        ) : !seat.isFolded ? (
          <>
            <PlayingCard card="" faceDown />
            <PlayingCard card="" faceDown />
          </>
        ) : null}
      </div>

      {/* Bet amount */}
      {seat.bet > 0 && (
        <div className="bg-yellow-500 text-black text-xs font-bold px-2 py-0.5 rounded-full">
          {seat.bet.toFixed(2)}
        </div>
      )}

      {/* Avatar + name */}
      <div className={`
        w-10 h-10 rounded-full flex items-center justify-center text-lg font-bold
        ${isMe ? 'bg-blue-600' : 'bg-gray-600'}
        ${seat.isDealer ? 'ring-2 ring-white' : ''}
        relative
      `}>
        {seat.username.charAt(0).toUpperCase()}
        {seat.isDealer && (
          <div className="absolute -top-1 -right-1 w-5 h-5 bg-white text-gray-900 rounded-full text-xs flex items-center justify-center font-bold">D</div>
        )}
        {!seat.isConnected && (
          <div className="absolute -bottom-0.5 -right-0.5 w-3 h-3 bg-red-500 rounded-full" />
        )}
      </div>

      <span className="text-white text-xs font-medium truncate max-w-[64px]">
        {isMe ? 'You' : seat.username}
      </span>

      <span className={`text-xs font-bold ${seat.isAllIn ? 'text-orange-400' : 'text-green-400'}`}>
        {seat.isAllIn ? 'ALL IN' : `${seat.stack.toFixed(2)}`}
      </span>
    </div>
  );
}

// ─── Action Panel ─────────────────────────────────────────────────────────────

function ActionPanel({ myUserId }: { myUserId: string }) {
  const { tableState, sendAction } = useGameStore();
  const [raiseAmount, setRaiseAmount] = useState(0);

  if (!tableState?.currentAction) return null;
  const action = tableState.currentAction;
  if (action.userId !== myUserId) return null;

  const handleAction = (type: string, amount = 0) => {
    hapticImpact('medium');
    sendAction(type, amount);
  };

  const timeLeft = action.timeoutSecs;

  return (
    <div className="fixed bottom-0 left-0 right-0 bg-gray-900/95 backdrop-blur-sm border-t border-gray-700 p-4 safe-area-pb">
      {/* Timer bar */}
      <div className="w-full h-1 bg-gray-700 rounded mb-3">
        <div
          className="h-1 bg-yellow-400 rounded transition-all"
          style={{ width: `${(timeLeft / action.timeoutSecs) * 100}%` }}
        />
      </div>

      {/* Pot info */}
      <div className="text-center text-gray-400 text-xs mb-3">
        Pot: <span className="text-white font-bold">{action.currentPot.toFixed(2)} TON</span>
        {action.callAmount > 0 && (
          <> · Call: <span className="text-yellow-400 font-bold">{action.callAmount.toFixed(2)} TON</span></>
        )}
      </div>

      {/* Raise slider (if raise available) */}
      {action.availableActions.includes('raise') && (
        <div className="mb-3">
          <input
            type="range"
            min={action.minRaise}
            max={action.maxRaise}
            step={tableState.bigBlind}
            value={raiseAmount || action.minRaise}
            onChange={e => setRaiseAmount(parseFloat(e.target.value))}
            className="w-full accent-yellow-400"
          />
          <div className="flex justify-between text-xs text-gray-400 mt-1">
            <span>Min: {action.minRaise.toFixed(2)}</span>
            <span className="text-yellow-400 font-bold">{(raiseAmount || action.minRaise).toFixed(2)} TON</span>
            <span>Max: {action.maxRaise.toFixed(2)}</span>
          </div>
        </div>
      )}

      {/* Action buttons */}
      <div className="flex gap-2">
        {action.availableActions.includes('fold') && (
          <button
            onClick={() => { hapticNotification('warning'); handleAction('fold'); }}
            className="flex-1 py-3 bg-red-600 hover:bg-red-700 active:scale-95 text-white font-bold rounded-xl transition-all"
          >
            Fold
          </button>
        )}

        {action.availableActions.includes('check') && (
          <button
            onClick={() => handleAction('check')}
            className="flex-1 py-3 bg-gray-600 hover:bg-gray-500 active:scale-95 text-white font-bold rounded-xl transition-all"
          >
            Check
          </button>
        )}

        {action.availableActions.includes('call') && (
          <button
            onClick={() => handleAction('call')}
            className="flex-1 py-3 bg-blue-600 hover:bg-blue-700 active:scale-95 text-white font-bold rounded-xl transition-all"
          >
            Call {action.callAmount.toFixed(2)}
          </button>
        )}

        {action.availableActions.includes('raise') && (
          <button
            onClick={() => handleAction('raise', raiseAmount || action.minRaise)}
            className="flex-1 py-3 bg-yellow-500 hover:bg-yellow-400 active:scale-95 text-black font-bold rounded-xl transition-all"
          >
            Raise
          </button>
        )}

        {action.availableActions.includes('all_in') && (
          <button
            onClick={() => { hapticImpact('heavy'); handleAction('all_in'); }}
            className="flex-1 py-3 bg-orange-600 hover:bg-orange-700 active:scale-95 text-white font-bold rounded-xl transition-all"
          >
            All In
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Community Cards ─────────────────────────────────────────────────────────

function CommunityCards({ cards }: { cards: string[] }) {
  return (
    <div className="flex gap-2 justify-center">
      {[0, 1, 2, 3, 4].map(i => (
        cards[i]
          ? <PlayingCard key={i} card={cards[i]} />
          : <div key={i} className="w-10 h-14 rounded-md border-2 border-dashed border-gray-600 opacity-30" />
      ))}
    </div>
  );
}

// ─── Main Table ───────────────────────────────────────────────────────────────

export function PokerTable({ myUserId }: { myUserId: string }) {
  const { tableState, myCards, error } = useGameStore();

  if (!tableState) {
    return (
      <div className="flex items-center justify-center h-screen bg-gray-950 text-white">
        <div className="text-center">
          <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-gray-400">Connecting to table...</p>
        </div>
      </div>
    );
  }

  const myActionRequired = tableState.currentAction?.userId === myUserId;

  return (
    <div className="relative min-h-screen bg-gray-950 overflow-hidden">
      {/* Felt background */}
      <div className="absolute inset-0 bg-gradient-to-b from-green-900 to-green-950 opacity-80" />

      {/* Table oval */}
      <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-72 h-44 bg-green-800 rounded-full border-4 border-yellow-700 shadow-2xl" />

      {/* Error toast */}
      {error && (
        <div className="absolute top-4 left-4 right-4 bg-red-600 text-white text-sm font-medium px-4 py-2 rounded-xl z-50 text-center animate-fade-in">
          {error}
        </div>
      )}

      {/* Status bar */}
      <div className="relative z-10 flex justify-between items-center px-4 pt-3 pb-2">
        <span className="text-gray-300 text-xs">Hand #{tableState.handNumber}</span>
        <span className="text-gray-300 text-xs">
          {tableState.smallBlind}/{tableState.bigBlind} TON
        </span>
        <div className={`w-2 h-2 rounded-full ${tableState.status === 'active' ? 'bg-green-400' : 'bg-yellow-400'}`} />
      </div>

      {/* Players arranged around table */}
      <div className="relative z-10 p-4">
        {/* Top seats (opponents) */}
        <div className="flex justify-around mb-4">
          {tableState.seats.filter((_, i) => i < 3).map(seat => (
            <PlayerSeat
              key={seat.userId}
              seat={seat}
              myUserId={myUserId}
              isActing={tableState.currentAction?.userId === seat.userId}
              myCards={myCards}
              showdownCards={tableState.showdownCards}
            />
          ))}
        </div>

        {/* Middle — pot and community cards */}
        <div className="flex flex-col items-center gap-3 my-8">
          {/* Pots */}
          <div className="flex gap-2">
            {tableState.pots.map((pot, i) => (
              <div key={i} className="bg-black/60 text-yellow-400 text-sm font-bold px-3 py-1 rounded-full">
                {pot.label}: {pot.amount.toFixed(2)} TON
              </div>
            ))}
          </div>

          {/* Community cards */}
          <CommunityCards cards={tableState.communityCards} />

          {/* Winners banner */}
          {tableState.winners && (
            <div className="bg-yellow-500 text-black text-sm font-bold px-4 py-2 rounded-xl animate-bounce-in">
              🏆 {tableState.winners.map(w => `+${w.amount.toFixed(2)} TON`).join(' ')}
            </div>
          )}
        </div>

        {/* Bottom seats (me + opponents) */}
        <div className="flex justify-around mt-4">
          {tableState.seats.filter((_, i) => i >= 3).map(seat => (
            <PlayerSeat
              key={seat.userId}
              seat={seat}
              myUserId={myUserId}
              isActing={tableState.currentAction?.userId === seat.userId}
              myCards={myCards}
              showdownCards={tableState.showdownCards}
            />
          ))}
        </div>
      </div>

      {/* Action panel (only shown when it's my turn) */}
      {myActionRequired && <ActionPanel myUserId={myUserId} />}
    </div>
  );
}
