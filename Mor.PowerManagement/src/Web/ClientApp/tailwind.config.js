/** @type {import('tailwindcss').Config} */
// Ant Design Enterprise Power Ops — design tokens.
// Source of truth: DESIGN.md (see MUST_READ.md section 10). Every colour,
// type step, radius and spacing value here comes from that file, so the theme
// and the written standard cannot drift apart.
//
// Tailwind radius names are remapped to the Ant scale rather than adding new
// names, because the mockups use the stock classes (rounded / rounded-lg /
// rounded-xl) and expect Ant geometry under those names.

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        // --- Neutral surface architecture (four tiers) ---
        surface: '#fcf9f8',
        'surface-dim': '#dcd9d9',
        'surface-bright': '#fcf9f8',
        'surface-container-lowest': '#ffffff',
        'surface-container-low': '#f6f3f2',
        'surface-container': '#f0eded',
        'surface-container-high': '#eae7e7',
        'surface-container-highest': '#e5e2e1',
        'surface-variant': '#e5e2e1',
        background: '#fcf9f8',
        'on-background': '#1b1b1c',
        'on-surface': '#1b1b1c',
        'on-surface-variant': '#414755',

        // --- Brand / primary ---
        'surface-tint': '#0059c7',
        primary: '#0057c2',
        'on-primary': '#ffffff',
        'primary-container': '#006ef2',
        'on-primary-container': '#fefcff',
        'inverse-primary': '#afc6ff',
        'primary-fixed': '#d9e2ff',
        'primary-fixed-dim': '#afc6ff',
        'on-primary-fixed': '#001a43',
        'on-primary-fixed-variant': '#004398',

        // --- Secondary / success ---
        secondary: '#266d00',
        'on-secondary': '#ffffff',
        'secondary-container': '#85fa51',
        'on-secondary-container': '#287100',
        'secondary-fixed': '#88fd54',
        'secondary-fixed-dim': '#6de039',
        'on-secondary-fixed': '#062100',
        'on-secondary-fixed-variant': '#1a5200',

        // --- Tertiary / warning ---
        tertiary: '#7d5400',
        'on-tertiary': '#ffffff',
        'tertiary-container': '#9d6a00',
        'on-tertiary-container': '#fffbff',
        'tertiary-fixed': '#ffddb0',
        'tertiary-fixed-dim': '#ffba45',
        'on-tertiary-fixed': '#281800',
        'on-tertiary-fixed-variant': '#614000',

        // --- Error / critical ---
        error: '#ba1a1a',
        'on-error': '#ffffff',
        'error-container': '#ffdad6',
        'on-error-container': '#93000a',

        // --- Outline ---
        outline: '#727786',
        'outline-variant': '#c1c6d7',
        'inverse-surface': '#303030',
        'inverse-on-surface': '#f3f0ef',
      },

      fontFamily: {
        sans: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        body: ['Inter', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        'headline-sm': ['Inter', 'sans-serif'],
        'headline-md': ['Inter', 'sans-serif'],
        'headline-lg': ['Inter', 'sans-serif'],
        'title-md': ['Inter', 'sans-serif'],
        'title-lg': ['Inter', 'sans-serif'],
        'body-sm': ['Inter', 'sans-serif'],
        'body-md': ['Inter', 'sans-serif'],
        'body-lg': ['Inter', 'sans-serif'],
        // Every numeral is JetBrains Mono with tabular figures so streaming
        // values never shift horizontally while they update.
        mono: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        code: ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        'metric-display': ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
        'metric-value': ['"JetBrains Mono"', 'ui-monospace', 'monospace'],
      },

      fontSize: {
        'headline-lg': ['30px', { lineHeight: '38px' }],
        'headline-md': ['24px', { lineHeight: '32px' }],
        'headline-sm': ['20px', { lineHeight: '28px' }],
        'title-lg': ['16px', { lineHeight: '24px' }],
        'title-md': ['14px', { lineHeight: '22px' }],
        'body-lg': ['16px', { lineHeight: '24px' }],
        'body-md': ['14px', { lineHeight: '22px' }],
        'body-sm': ['12px', { lineHeight: '20px' }],
        'metric-display': ['28px', { lineHeight: '34px', letterSpacing: '-0.02em' }],
        'metric-value': ['14px', { lineHeight: '20px' }],
        code: ['12px', { lineHeight: '18px' }],
      },

      // Ant radius scale, mapped onto Tailwind's stock names.
      borderRadius: {
        none: '0',
        sm: '2px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
        xl: '8px',
        '2xl': '12px',
        full: '9999px',
      },

      spacing: {
        gutter: '1rem',
        margin: '1.5rem',
        'space-xs': '0.25rem',
        'space-sm': '0.5rem',
        'space-md': '1rem',
        'space-lg': '1.5rem',
        'space-xl': '2rem',
      },

      boxShadow: {
        // Flat-first: depth comes from hairlines and tonal contrast, so the
        // shadows stay almost imperceptible (DESIGN.md "Elevation & Depth").
        sm: '0 1px 2px 0 rgba(0,0,0,0.03), 0 1px 6px -1px rgba(0,0,0,0.02)',
        DEFAULT: '0 6px 16px 0 rgba(0,0,0,0.08), 0 3px 6px -4px rgba(0,0,0,0.04)',
        md: '0 6px 16px 0 rgba(0,0,0,0.08), 0 3px 6px -4px rgba(0,0,0,0.04)',
        lg: '0 9px 28px 8px rgba(0,0,0,0.05)',
        focus: '0 0 0 2px rgba(0,87,194,0.2)',
      },

      spacing2: {},
    },
    // Standard control height is 32px everywhere (h-8 in the stock scale),
    // which is already correct in Tailwind's default spacing scale.
  },
  plugins: [],
};