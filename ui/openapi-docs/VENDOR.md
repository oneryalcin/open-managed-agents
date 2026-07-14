# Vendored Swagger UI assets

The files under `vendor/` are copied from the npm tarball for
`swagger-ui-dist@5.32.8`.

- Package: `swagger-ui-dist`
- Version: `5.32.8`
- License: Apache-2.0 (preserved as `vendor/LICENSE` and `vendor/NOTICE`)
- npm integrity:
  `sha512-dgMdWXIgnI4zX4OPhKEdWnlDODbgm8W3AX0Ivn/BBqcUh6xZsBxhZMnvk6DJyRz1BTrj8dPxtarmEGgkz30oyA==`
- Retrieved: 2026-07-14 with `npm pack swagger-ui-dist@5.32.8`

Only the browser runtime assets required by OMA are vendored. Source maps,
OAuth redirect helpers, icons, and package lifecycle dependencies are omitted.
The initializer disables Swagger UI's remote schema validator and credential
persistence so the documentation works air-gapped and API keys remain in page
memory.

SHA-256:

```text
97f03cdae8b9f09f8f33b604ed4796bd318c378e90763b468bb4aa0860bd90a7  swagger-ui-bundle.js
3b5efc014c67162d35ea0870a8ddb0096c0bc5092b72cb27ff48a289ecfb8983  swagger-ui-standalone-preset.js
ca238f7d7c2cf4480c1e77a9c3b9da915ab216e96ffd354e69076560c650c6de  swagger-ui.css
cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30  LICENSE
0d20d1adef18aee3f40dd258172155521ce702ac445cb5f7b7d60ed32dad2fb2  NOTICE
```
