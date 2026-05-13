/**
 * Telegram Mini App SDK wrapper.
 * Abstracts WebApp API and provides typed access.
 */

declare global {
  interface Window {
    Telegram: {
      WebApp: TelegramWebApp;
    };
  }
}

interface TelegramWebApp {
  initData: string;
  initDataUnsafe: {
    user?: {
      id: number;
      first_name: string;
      last_name?: string;
      username?: string;
      photo_url?: string;
    };
    start_param?: string;
  };
  version: string;
  platform: string;
  colorScheme: 'light' | 'dark';
  themeParams: Record<string, string>;
  isExpanded: boolean;
  viewportHeight: number;
  viewportStableHeight: number;
  ready: () => void;
  expand: () => void;
  close: () => void;
  showAlert: (message: string, callback?: () => void) => void;
  showConfirm: (message: string, callback: (confirmed: boolean) => void) => void;
  showPopup: (params: any, callback?: (buttonId: string) => void) => void;
  HapticFeedback: {
    impactOccurred: (style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft') => void;
    notificationOccurred: (type: 'error' | 'success' | 'warning') => void;
    selectionChanged: () => void;
  };
  MainButton: {
    text: string;
    color: string;
    textColor: string;
    isVisible: boolean;
    isActive: boolean;
    show: () => void;
    hide: () => void;
    enable: () => void;
    disable: () => void;
    setText: (text: string) => void;
    onClick: (callback: () => void) => void;
    offClick: (callback: () => void) => void;
    showProgress: (leaveActive?: boolean) => void;
    hideProgress: () => void;
  };
  BackButton: {
    isVisible: boolean;
    show: () => void;
    hide: () => void;
    onClick: (callback: () => void) => void;
    offClick: (callback: () => void) => void;
  };
}

export function getTelegramWebApp(): TelegramWebApp | null {
  return window.Telegram?.WebApp ?? null;
}

export function getInitData(): string {
  return window.Telegram?.WebApp?.initData ?? '';
}

export function getTelegramUser() {
  return window.Telegram?.WebApp?.initDataUnsafe?.user ?? null;
}

export function initializeTelegramApp() {
  const twa = getTelegramWebApp();
  if (!twa) {
    console.warn('Not running in Telegram — using dev mode');
    return;
  }
  twa.ready();
  twa.expand(); // Full screen
}

export function hapticImpact(style: 'light' | 'medium' | 'heavy' = 'light') {
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(style);
}

export function hapticNotification(type: 'success' | 'error' | 'warning') {
  window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(type);
}

export function showTelegramAlert(message: string): Promise<void> {
  return new Promise(resolve => {
    const twa = getTelegramWebApp();
    if (twa) {
      twa.showAlert(message, resolve);
    } else {
      alert(message);
      resolve();
    }
  });
}

export function isDarkMode(): boolean {
  return window.Telegram?.WebApp?.colorScheme === 'dark';
}

export function getStartParam(): string | undefined {
  return window.Telegram?.WebApp?.initDataUnsafe?.start_param;
}
