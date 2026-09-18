// Tailwind config for this app's precompiled stylesheet.
//
// The Dockerfile's builder stage runs the Tailwind CLI over the globs below
// and writes public/tailwind.css, which public/index.html links as
// /tailwind.css. Nothing is committed — every image build regenerates it.
//
// To build it locally (optional; the image build does this for you):
//   npm install --no-save tailwindcss@3.4.17
//   npx tailwindcss -c tailwind.config.js -i styles/tailwind-input.css \
//     -o public/tailwind.css --minify
const defaultTheme = require('tailwindcss/defaultTheme');

module.exports = {
  // Every file that can contain a class name. Tailwind's extractor is a
  // regex over source text, so it finds class names written as whole
  // literals — including ones inside JS strings in these files.
  content: [
    './public/**/*.html',
    './public/**/*.js',
  ],

  // Classes this app builds dynamically (if it ever does) go here, since the
  // extractor cannot see them. Prefer whole literals in the markup instead.
  safelist: [],

  // Stops hover: styles sticking after a tap on touch screens. Required by
  // the usernode-native UI kit and harmless without it.
  future: { hoverOnlyWhenSupported: true },

  theme: {
    extend: {
      // Overrides the "sans" stack Tailwind's preflight applies to <html>,
      // so the playful body font cascades to every screen with no class
      // needed anywhere. Headings get their own rounder face via a plain
      // CSS rule in index.html instead of a utility class, so JS-templated
      // headings pick it up too.
      fontFamily: {
        sans: ['Quicksand', ...defaultTheme.fontFamily.sans],
        heading: ['"Baloo 2"', ...defaultTheme.fontFamily.sans],
      },
    },
  },
  plugins: [],
};
