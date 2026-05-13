import type { AppProps } from 'next/app';
import Head from 'next/head';
import { useEffect } from 'react';
import '../styles/globals.css';

export default function App({ Component, pageProps }: AppProps) {
  useEffect(() => {
    // Initialize Telegram Mini App
    const twa = window.Telegram?.WebApp;
    if (twa) {
      twa.ready();
      twa.expand();
    }
  }, []);

  return (
    <>
      <Head>
        <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no" />
        <meta name="theme-color" content="#1b4332" />
        <title>TON Poker</title>
        {/* Telegram Mini App SDK */}
        <script src="https://telegram.org/js/telegram-web-app.js" />
      </Head>
      <Component {...pageProps} />
    </>
  );
}
