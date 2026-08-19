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

  // Matches the <html class="dark"> in public/index.html: dark: variants key
  // off that class rather than the OS colour-scheme preference.
  darkMode: 'class',

  // Stops hover: styles sticking after a tap on touch screens. Required by
  // the usernode-native UI kit and harmless without it.
  future: { hoverOnlyWhenSupported: true },

  theme: { extend: {} },
  plugins: [],
};
