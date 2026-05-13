/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ['./src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        felt: { DEFAULT: '#2d6a4f', dark: '#1b4332', light: '#40916c' },
        chip: { gold: '#f4a261', silver: '#adb5bd' },
      },
      animation: {
        'fade-in': 'fadeIn 0.2s ease-in-out',
        'slide-up': 'slideUp 0.3s ease-out',
        'pulse-glow': 'pulseGlow 1.5s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: { from: { opacity: 0 }, to: { opacity: 1 } },
        slideUp: { from: { transform: 'translateY(20px)', opacity: 0 }, to: { transform: 'translateY(0)', opacity: 1 } },
        pulseGlow: { '0%,100%': { boxShadow: '0 0 4px rgba(250,204,21,0.4)' }, '50%': { boxShadow: '0 0 16px rgba(250,204,21,0.8)' } },
      },
    },
  },
  plugins: [],
};
