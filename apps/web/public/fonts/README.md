# Satoshi font files

This directory is where Dom drops the two Satoshi variable font files:

- `Satoshi-Variable.woff2`
- `Satoshi-VariableItalic.woff2`

They come from [Fontshare](https://www.fontshare.com/fonts/satoshi) under the
Fontshare free licence and are not redistributed in this repository.

`src/app/globals.css` declares the `@font-face` rules that point at these two
paths with `font-display: swap`. Until the files are present here, the body
font stack falls back to `system-ui, sans-serif` and the UI otherwise renders
normally.
