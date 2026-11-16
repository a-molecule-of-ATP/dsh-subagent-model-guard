# Vendored dependencies

`node_modules/@deepseek-ai/schemastery` (3.19.0) and
`node_modules/@deepseek-ai/cosmokit` (1.9.0) are unmodified copies extracted
from the running DeepSeek Harness installation
(`app.asar` → `dsh/node_modules/@deepseek-ai/...`).

They are vendored because an externally linked plugin cannot resolve the
harness's internal `@deepseek-ai/*` packages: Node looks in the plugin's own
`node_modules`, and `ERR_MODULE_NOT_FOUND` is thrown otherwise.

## Consequences

- **Link install only.** `npm pack` / any registry or git install drops
  `node_modules`, so `import Schema from '@deepseek-ai/schemastery'` would fail.
  Keep installing this plugin with `link:` (plugin_manager does that).
- **Re-extract after a DSH upgrade** if the harness bumps schemastery or
  cosmokit; delete both directories here and copy the new versions from the
  new `app.asar`.

## Verify

```bash
node -e "console.log(require('./node_modules/@deepseek-ai/schemastery/package.json').version, require('./node_modules/@deepseek-ai/cosmokit/package.json').version)"
node --input-type=module -e "import S from '@deepseek-ai/schemastery'; console.log(typeof S.object)"
```
