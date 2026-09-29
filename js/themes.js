// Shared theme data: the page maps `css` onto :root custom properties, the stage reads `stage`.
// Select with ?theme=<name>. `studio` is the v1 look.
// Note: `--ivory` is the primary TEXT colour and `--wall` the page background, whatever their hue.

export const THEMES = {
  studio: {
    label: 'Studio',
    css: {
      '--wall': '#1f2326', '--wall-2': '#15181a', '--ivory': '#ede4cf', '--dim': '#a9aeac',
      '--noodle': '#f4c430', '--trained': '#3fb39a', '--held': '#f08a24',
    },
    stage: {
      background: '#454d52', fog: '#2a3134', table: '#66625b',
      ring: '#ffd899', key: '#fff0dc', fill: '#fff4e6', rim: '#b4c8f0',
      trained: '#3fb39a', held: '#f08a24', accent: '#f4c430',
      arc: '#4fbfa5', trail: '#ffd161', frustum: '#8ff0d6',
      exposure: 1.0, bloom: 1.0,
    },
  },

  // Orange–teal cinematic night: cool ink studio, warm ring, electric teal grid, hot orange B2.
  nocturne: {
    label: 'Nocturne',
    css: {
      '--wall': '#0c1626', '--wall-2': '#060b15', '--ivory': '#f4ecd8', '--dim': '#a3b3c6',
      '--noodle': '#ffc93c', '--trained': '#2fe0c2', '--held': '#ff7a1a',
    },
    stage: {
      background: '#0c1626', fog: '#060b15', table: '#3a465e',
      ring: '#ffc27a', key: '#ffe6c4', fill: '#4f86d9', rim: '#5ab8ff',
      trained: '#2fe0c2', held: '#ff7a1a', accent: '#ffc93c',
      arc: '#46f0d4', trail: '#ffd166', frustum: '#6ff5e0',
      exposure: 1.05, bloom: 1.25,
    },
  },

  // Warm film-set luxe: espresso studio, amber ring glow, sage-teal grid, vermilion B2.
  ember: {
    label: 'Ember',
    css: {
      '--wall': '#1b130d', '--wall-2': '#0e0906', '--ivory': '#fbefdc', '--dim': '#c2ab91',
      '--noodle': '#ffcf33', '--trained': '#5fd3b0', '--held': '#ff5a1f',
    },
    stage: {
      background: '#1b130d', fog: '#0e0906', table: '#5b4737',
      ring: '#ffb45c', key: '#ffe2b8', fill: '#a4775a', rim: '#ffcf99',
      trained: '#5fd3b0', held: '#ff5a1f', accent: '#ffcf33',
      arc: '#ffd48a', trail: '#fff0b0', frustum: '#ffdcaa',
      exposure: 1.05, bloom: 1.15,
    },
  },

  // Bright product-page daylight: pale cool cyclorama, dark ink type, saturated accents.
  daylight: {
    label: 'Daylight',
    css: {
      '--wall': '#e8ebed', '--wall-2': '#d3d8dc', '--ivory': '#121619', '--dim': '#4f5962',
      '--noodle': '#e0a200', '--trained': '#0e9c82', '--held': '#e25c08',
    },
    stage: {
      background: '#e8ebed', fog: '#d3d8dc', table: '#f4f5f6',
      ring: '#ffb45e', key: '#ffffff', fill: '#dfe7ee', rim: '#ffffff',
      trained: '#0e9c82', held: '#e25c08', accent: '#e0a200',
      arc: '#0e9c82', trail: '#e0a200', frustum: '#0e9c82',
      exposure: 0.95, bloom: 0.6,
    },
  },
}

export const DEFAULT_THEME = 'nocturne'

export function themeFromURL(search = location.search) {
  const name = new URLSearchParams(search).get('theme')
  return name && THEMES[name] ? name : DEFAULT_THEME
}
