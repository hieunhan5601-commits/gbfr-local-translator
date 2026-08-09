# CodeGraph status

- Package: `@colbymchenry/codegraph@1.5.0`
- Project index: initialized
- Source files indexed: 22 JavaScript files
- Nodes: 325
- Edges: 932
- Storage: local SQLite, WAL
- Database size at validation: 1.38 MB
- Sync state: up to date

Scope exclusions are defined in `codegraph.json` and `.gitignore`. The local `.codegraph/` index is intentionally not part of GitHub commits.

Validation commands:

```bash
npm run codegraph:status
codegraph explore "runHybridProduction context contract release gate"
```

The exploration resolved the production call path, context fingerprint, immutable contract, release gate and test blast radius from the graph.
