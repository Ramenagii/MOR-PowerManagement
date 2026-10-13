/** @type {import('tailwindcss').Config} */
// -----------------------------------------------------------------------------
// Precision Instrumentation System — design tokens.
//
// Source of truth: DESIGN.md, "Precision Instrumentation System". Both halves of
// that document are used: the frontmatter supplies the TOKEN NAMES (so the
// semantic class names the components already use — `bg-surface-container-lowest`,
// `text-on-surface-variant`, `border-outline-variant` — keep working) and the
// written standard supplies the VALUES. The written standard wins on colour,
// because it is the half a human signed off on:
//
//   Canvas Base      #FBFBFA   ambient porcelain
//   Surface Level 1  #F5F5F3   card, panel, data-grid container
//   Surface Level 2  #ECECE9   inset wells, readout wells, table headers
//   Border Subtle    #E6E6E2   default hairline
//   Border Medium    #DFDFDA   focused states, structural splits
//   Ink Primary      #1F2429   metrics, alerts, headings
//   Ink Secondary    #4B5563   labels, secondary readings
//   Ink Muted        #6B7280   timestamps, inactive states, static units
//
// Four domain status washes, each a foreground / fill / border triple:
//   nominal   #2A7E68 / #EBF6F1 / #D1ECE0
//   info      #2B5A8F / #EBF2FE / #D5E4FC     <- also the interactive accent
//   advisory  #B46928 / #FEF6E9 / #FDE8C8
//   critical  #C24136 / #FDF0EE / #FBD9D5
//
// Typography: Geist for structure, JetBrains Mono for low-level machine
// telemetry only, `tabular-nums` activated system-wide from styles.css.
//
// Geometry: cards 8-12px, form controls locked to 8px, chips and status
// indicators full pills. Radii are remapped onto Tailwind's stock names so the
// existing markup lands on the documented geometry without touching a class.
// -----------------------------------------------------------------------------

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    // DESIGN.md "Responsive Breakpoints": compact 320-767, intermediate
    // 768-1199, expanded 1200+ capped at 1440. `md:` is therefore the 8-column
    // switch and `xl:` the 12-column switch, which is what every view's
    // `sm:grid-cols-2 xl:grid-cols-4` was already reaching for.
    screens: {
      sm: '480px',
      md: '768px',
      lg: '1024px',
      xl: '1200px',
      '2xl': '1440px',
    },
    extend: {
      colors: {
        // --- Surface tiers: canvas, card, well, track -------------------------
        // Inverted against stock M3 on purpose. DESIGN.md puts the ambient canvas
        // at #FBFBFA and steps DOWN into cards and wells, so depth comes from
        // tonal subtraction rather than from white cards floating on grey.
        background: '#FBFBFA',
        surface: '#FBFBFA',
        'surface-dim': '#DFDFDA',
        'surface-bright': '#FFFFFF',
        // CARD. The token name is inherited from the M3 vocabulary the markup
        // already speaks; its value is DESIGN.md's Surface Level 1.
        'surface-container-lowest': '#F5F5F3',
        // WELL. Inset readout wells, the V/A/W strip, table headers.
        'surface-container-low': '#ECECE9',
        // Meter tracks and structural divides, one step below the well.
        'surface-container': '#E6E6E2',
        'surface-container-high': '#E4E4E0',
        'surface-container-highest': '#DFDFDA',
        'surface-variant': '#ECECE9',

        // --- Ink -------------------------------------------------------------
        'on-surface': '#1F2429',
        'on-surface-variant': '#4B5563',
        outline: '#6B7280',
        // Border Subtle. Also used as a deliberate NEUTRAL indicator: a meter
        // backed reading is the absence of a caveat, not a celebration, so the
        // "measured" dot wears the hairline rather than the nominal green.
        'outline-variant': '#E6E6E2',
        // Border Medium: focused states, structural splits, interactive edges.
        'outline-strong': '#DFDFDA',
        'inverse-surface': '#2F3130',
        'inverse-on-surface': '#F1F1EF',

        // --- Info (cadet blue) — telemetry flow AND the interactive accent ---
        'surface-tint': '#2B5A8F',
        primary: '#2B5A8F',
        'on-primary': '#FFFFFF',
        'primary-container': '#EBF2FE',
        'on-primary-container': '#2B5A8F',
        'inverse-primary': '#D5E4FC',
        'primary-fixed': '#D5E4FC',
        'primary-fixed-dim': '#EBF2FE',
        'on-primary-fixed': '#1F2429',
        'on-primary-fixed-variant': '#2B5A8F',

        // --- Nominal ---------------------------------------------------------
        secondary: '#2A7E68',
        'on-secondary': '#FFFFFF',
        'secondary-container': '#EBF6F1',
        'on-secondary-container': '#2A7E68',
        'secondary-fixed': '#D1ECE0',
        'secondary-fixed-dim': '#EBF6F1',
        'on-secondary-fixed': '#1F2429',
        'on-secondary-fixed-variant': '#2A7E68',

        // --- Advisory --------------------------------------------------------
        // Foreground #B46928 is the advisory ink used as TEXT (the wash is
        // `tertiary-container`); a warning label that borrowed the wash colour
        // would be invisible on its own background.
        tertiary: '#B46928',
        'on-tertiary': '#FFFFFF',
        'tertiary-container': '#FEF6E9',
        'on-tertiary-container': '#B46928',
        'tertiary-fixed': '#FDE8C8',
        'tertiary-fixed-dim': '#FEF6E9',
        'on-tertiary-fixed': '#B46928',
        'on-tertiary-fixed-variant': '#B46928',

        // --- Critical --------------------------------------------------------
        error: '#C24136',
        'on-error': '#FFFFFF',
        'error-container': '#FDF0EE',
        'on-error-container': '#C24136',
        'error-fixed': '#FBD9D5',
        'error-fixed-dim': '#FDF0EE',

        // --- Legacy aliases the charts and older selectors still read --------
        accent: '#2B5A8F',
        'accent-soft': '#EBF2FE',
      },

      fontFamily: {
        // DESIGN.md "Typography": Geist provides the structural base for labels,
        // headers and UI copy.
        sans: ['Geist', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        body: ['Geist', '-apple-system', 'BlinkMacSystemFont', 'Segoe UI', 'Roboto', 'sans-serif'],
        'headline-sm': ['Geist', 'sans-serif'],
        'headline-md': ['Geist', 'sans-serif'],
        'headline-lg': ['Geist', 'sans-serif'],
        'headline-xl': ['Geist', 'sans-serif'],
        'title-lg': ['Geist', 'sans-serif'],
        'title-md': ['Geist', 'sans-serif'],
        'body-lg': ['Geist', 'sans-serif'],
        'body-md': ['Geist', 'sans-serif'],
        'body-sm': ['Geist', 'sans-serif'],
        'label-md': ['Geist', 'sans-serif'],
        'label-sm': ['Geist', 'sans-serif'],
        // JetBrains Mono is reserved EXCLUSIVELY for low-level machine
        // telemetry, hex logs, bus addresses, register allocations and
        // diagnostic status matrices.
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        code: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        'metric-value': ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
        // DESIGN.md types `metric-display` in Geist at weight 500 — it is a
        // structural headline figure, not a machine log. Tabular figures still
        // apply (styles.css sets them on the root), so streaming values align.
        'metric-display': ['Geist', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },

      // DESIGN.md `typography`. The written standard names only weights 400, 500
      // and 600 for the interface; nothing here may render thin or heavy.
      fontSize: {
        'headline-xl': ['2.25rem', { lineHeight: '2.75rem', letterSpacing: '-0.02em' }],
        'headline-lg': ['1.5rem', { lineHeight: '2rem', letterSpacing: '-0.015em' }],
        'headline-md': ['1.25rem', { lineHeight: '1.75rem', letterSpacing: '-0.01em' }],
        'headline-sm': ['1.125rem', { lineHeight: '1.5rem', letterSpacing: '-0.005em' }],
        'title-lg': ['1rem', { lineHeight: '1.5rem' }],
        'title-md': ['0.875rem', { lineHeight: '1.25rem' }],
        'body-lg': ['1rem', { lineHeight: '1.5rem' }],
        'body-md': ['0.875rem', { lineHeight: '1.375rem' }],
        'body-sm': ['0.75rem', { lineHeight: '1.125rem' }],
        'metric-display': ['2rem', { lineHeight: '2.25rem', letterSpacing: '-0.02em' }],
        'metric-value': ['0.875rem', { lineHeight: '1.25rem' }],
        'label-md': ['0.75rem', { lineHeight: '1rem', letterSpacing: '0.02em' }],
        'label-sm': ['0.6875rem', { lineHeight: '0.875rem', letterSpacing: '0.04em' }],
        code: ['0.75rem', { lineHeight: '1.125rem' }],
      },

      // DESIGN.md "Shapes": structural containers 8-12px, form controls locked
      // to 8px, chips and status indicators full pills. The stock names are
      // mapped rather than added to, so existing markup lands on the documented
      // geometry without a single class change.
      borderRadius: {
        none: '0',
        sm: '4px',
        DEFAULT: '8px',
        md: '8px',
        lg: '12px',
        xl: '16px',
        '2xl': '20px',
        full: '9999px',
      },

      // `gutter` and `margin` resolve through custom properties so the DESIGN.md
      // responsive rule (1rem / 1.5rem, 2rem from 768px) lives in CSS next to
      // the rest of the standard rather than being duplicated per class.
      spacing: {
        gutter: 'var(--gutter)',
        margin: 'var(--page-margin)',
        'space-xs': '0.25rem',
        'space-sm': '0.5rem',
        'space-md': '1rem',
        'space-lg': '1.5rem',
        'space-xl': '2.5rem',
      },

      // DESIGN.md "Elevation & Depth": quiet surface shifting and low-contrast
      // borders rather than pronounced drop shadows. The card shadow is almost
      // imperceptible by design; only overlays earn a real one.
      boxShadow: {
        none: 'none',
        sm: '0 1px 2px 0 rgba(31, 36, 41, 0.03)',
        DEFAULT: '0 1px 2px 0 rgba(31, 36, 41, 0.03)',
        md: '0 1px 2px 0 rgba(31, 36, 41, 0.03)',
        card: '0 1px 2px 0 rgba(31, 36, 41, 0.03)',
        lg: '0 12px 32px -4px rgba(31, 36, 41, 0.06), 0 4px 12px -2px rgba(31, 36, 41, 0.03)',
        xl: '0 12px 32px -4px rgba(31, 36, 41, 0.06), 0 4px 12px -2px rgba(31, 36, 41, 0.03)',
        focus: '0 0 0 3px rgba(43, 90, 143, 0.12)',
      },

      maxWidth: {
        // The 1440px optical path DESIGN.md caps the expanded layout at.
        canvas: '1440px',
      },
    },
  },
  plugins: [],
}