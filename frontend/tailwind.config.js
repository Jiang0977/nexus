/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        nexus: {
          bg: 'var(--nexus-bg)',
          'bg-2': 'var(--nexus-bg2)',
          'menu-bg': 'var(--nexus-menu-bg)',
          border: 'var(--nexus-border)',
          text: 'var(--nexus-text)',
          'text-2': 'var(--nexus-text2)',
          muted: 'var(--nexus-muted)',
          'tab-active': 'var(--nexus-tab-active)',
          accent: 'var(--nexus-accent)',
          success: 'var(--nexus-success)',
          warning: 'var(--nexus-warning)',
          error: 'var(--nexus-error)',
        },
      },
      fontFamily: {
        mono: ['Menlo', 'Monaco', '"Cascadia Code"', '"Fira Code"', 'monospace'],
      },
      animation: {
        'spin': 'spin 1s linear infinite',
        'pulse': 'pulse 2s cubic-bezier(0.4, 0, 0.6, 1) infinite',
        'slide-up': 'slideUp 0.2s ease-out',
      },
      keyframes: {
        spin: {
          'to': { transform: 'rotate(360deg)' },
        },
        pulse: {
          '0%, 100%': { opacity: '1' },
          '50%': { opacity: '0.3' },
        },
        slideUp: {
          'from': { opacity: '0', transform: 'translateY(10px)' },
          'to': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
}
