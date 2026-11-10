<!-- cspell:disable -->

# Headless terminal app (fork notes)

This branch (`headless-service`, cut from upstream `dev` at `64167f5fc`) makes the terminal app (`packages/app-cli`, npm `joplin`) usable as a long-running, headless Data API / MCP service, including semantic search. It is meant to replace running the interactive terminal UI inside tmux.

## What changed

The work is split into two independent pull requests' worth of commits, plus one commit that connects them. PR 2 applies cleanly to `dev` without PR 1 and type-checks on its own. PR 3 (sync before MCP reads) builds on PR 2.

| Commit | PR | Summary |
|---|---|---|
| `03d0a0de5` | 1 | Cli: Add support for local AI embeddings and semantic search |
| `ac7383143` | 1 | Cli: Show AI and MCP settings in the config command |
| `b20972621` | 2 | All: Allow apps without GUI to sync and index changes as they happen (`packages/lib`) |
| `eaa486a9f` | 2 | Cli: Add a headless service mode to the server command |
| `cda6b8b02` | 1 + 2 | Cli: Run the embedding indexer in headless service mode |
| `912e28645` | 3 | All: Allow MCP clients to sync before reading notes (`packages/lib`) |
| `c01e9f819` | 3 | Cli: Sync before MCP reads in headless service mode |

### PR 1: local embeddings in the terminal app

- `packages/app-cli/package.json`: adds `onnxruntime-node` 1.27.0, `sqlite-vec` 0.1.9 and `@huggingface/transformers` 4.2.0 as dependencies, the same versions as the desktop app.
- `main.js`: loads `sqlite-vec` and `onnxruntime-node` in `try`/`catch` (like `sharp`) and passes them to `shimInitCli`. If either fails to load (no prebuilt binary for the platform, etc.), the app still starts with embeddings unavailable. `JoplinDatabase` already logs whether the sqlite-vec extension loaded, and `app.ts` logs a warning when ONNX is missing.
- `app.ts`: registers `LocalEmbeddingProvider` right after `initRedux()`, before `Setting.dispatchUpdateAll()` triggers the settings side effects. This mirrors the desktop app's order.
- The background `EmbeddingIndexer` only runs in long-running modes. The CLI overrides the protected `applyEmbeddingIndexerState()` and returns early unless the app has a GUI (after the glue commit: unless `isLongRunning()`). The interactive UI calls it again once the GUI is up, because `hasGui()` is still false during the initial `dispatchUpdateAll()`. One-shot commands (`joplin config ...`, `joplin mknote ...`) never start the indexer. This fixes the race where a one-shot command on an empty profile completed the initial scan and set `ai.embedding.initialScanDone`. The query-side embedding provider is still registered in every mode, so semantic search works anywhere an index exists.
- Settings: `ai.enabled`, `mcp.enabled`, `ai.embedding.enabled` and the MCP tool permissions (`ai.tool.*.enabled`, except the chat-panel-only `edit_current`) are now tagged `AppType.Cli` as well as `AppType.Desktop`, so `joplin config` lists them. `appTypes` only affects listings (`Setting.keys()` / `publicSettings()`); the keys could already be set from the CLI. Chat-provider settings were left desktop-only because the CLI has no chat.

### PR 2: headless service mode

**`packages/lib` (the only lib change, kept minimal for rebasing):**

- `BaseApplication.isLongRunning()` (protected, defaults to `hasGui()`). It replaces `hasGui()` in exactly these places, where the check is about the process staying alive rather than about having a UI:
  - the upload-after-save sync (`reg.scheduleSync(syncAsYouTypeInterval, partial)`) and `SearchEngine.scheduleSyncTables()` on `NOTE_UPDATE_ONE` / `NOTE_DELETE` / `FOLDER_UPDATE_ONE` / `FOLDER_DELETE` (joplin#11631);
  - `sync.interval` side effect → `reg.setupRecurrentSync()`;
  - `syncInfoCache` side effect → `DecryptionWorker.scheduleStart()` + `reg.scheduleSync()`;
  - `SYNC_GOT_ENCRYPTED_ITEM` → `DecryptionWorker.scheduleStart()`;
  - `SYNC_CREATED_OR_UPDATED_RESOURCE` → `ResourceFetcher.autoAddResources()`.

  These stay on `hasGui()` because they really need a UI: `switchCurrentFolder`, the start-up `currentFolder_` assignment, all `refreshNotes` triggers, and all folder-list refreshes. Desktop's `hasGui()` returns true, so behaviour is unchanged for existing apps.
- `Registry.setRecurrentSyncIntervalOverride(seconds | null)`: `setupRecurrentSync()` uses this instead of the `sync.interval` setting when set. This was needed because the registry re-arms the recurrent timer from the setting after every scheduled sync, and the setting is an enum (0, 5 min, 10 min, …).

**`packages/app-cli`:**

- `joplin server start --service [--sync-interval <seconds>]` (new options on the existing `server` command; `server start` without `--service` is unchanged).
- `Application.startHeadless()` sets the long-running flag and starts what the interactive UI starts: `ResourceService.runInBackground()`, `RevisionService.runInBackground()`, `DecryptionWorker.scheduleStart()`, `reg.setupRecurrentSync()`, the embedding indexer and rotating log maintenance. `ResourceFetcher` (attachment downloads), search-index sync and trash auto-deletion (`setupAutoDeletion`) are already started by `BaseApplication.start()` in every mode.
- `services/headless/HeadlessService.ts`:
  - Tracks sync start, end and errors from the Redux store. The synchronizer dispatches its final report, errors included, before `SYNC_COMPLETED`.
  - Coalesces sync requests: a request waits for any sync in progress to finish, then runs a full sync; requests made while one is waiting share it.
  - After every completed sync it triggers `EmbeddingIndexer.maintenance()`. This is guarded against concurrent runs. Without it, the indexer only polls the change feed every 3 minutes once its initial scan is done. Syncs also run about 1 s after local saves, so this covers notes created through MCP too.
  - Serves the control endpoints (below) through the existing `ClipperServer.initialize(actionApi)` hook, so no new routes were needed. They are not MCP tools.
- Startup: an initial full sync (when a sync target is configured), then recurrent sync at `--sync-interval`.
- Logs to stdout and stderr (a console target on the global logger, format `YYYY-MM-DD HH:mm:ss: level: prefix: message`) as well as `log.txt`. Requests are still logged to `log-clipper.txt` and stdout; use `--quiet` to keep only errors on stdout.
- SIGTERM/SIGINT: stops the HTTP server and the indexer, then calls `app().exit(0)`. That cancels a sync in progress (`Synchronizer.cancel()`, which waits until the sync is idle) and saves settings. A second signal, or 9 s without finishing, exits with code 1.
- Fatal errors exit non-zero: the port already in use (`Server is already running on port N`, exit 1), an invalid `--sync-interval` (exit 1), and uncaught exceptions or unhandled rejections (Node's default, exit 1). Sync errors are not fatal; they are logged and reported by `status`.

### Sync timing and coalescing

- Timer: `--sync-interval` seconds (minimum 10). This calls `scheduleSync(0)`.
- After a local change: an upload-only partial sync 1 s later (`reg.syncAsYouTypeInterval()` outside Electron), debounced by `scheduleSync` (each call replaces the pending timer). If a sync is already running, none is scheduled, but `Synchronizer.start()` itself re-schedules a sync at the end if outgoing changes remain, so changes made during a sync are not left behind.
- Requests through the `sync` endpoint: see `HeadlessService.requestSync()` above.
- Overlap: `Synchronizer.start()` throws `alreadyStarted` when a sync is running, and `scheduleSync` swallows that. Two syncs never run at once.
- Downloads only happen on full syncs (timer, startup, `sync` endpoint). Joplin Server can't push.

### PR 3: sync before MCP reads

Without this, an agent only sees changes made on other devices after the next timer sync, so a note synced from a phone or desktop could be missing for up to `--sync-interval` seconds (plus the full-text search debounce).

- `packages/lib`: tools have an optional `readsNotes` flag, set on `search_notes`, `semantic_search_notes`, `read_note`, `read_notes`, `list_notebooks`, `list_tags`, `read_image` and `update_note` (it reads the body it edits, so a stale copy would cause a conflict). `McpServer.setPreReadSync(hook)` registers a hook. Only when one is registered do the flagged tools list a `sync` boolean argument (default `true`). The server strips the argument and, unless it is `false`, awaits the hook before running the tool. A warning returned by the hook, or an exception it throws, is added to the tool result as an extra `Warning: …` text item. The read still uses the local data. A non-boolean `sync` is a tool error. Desktop doesn't register a hook, so its MCP server and the chat panel's tools are unchanged.
- `packages/app-cli`: `HeadlessService.preReadSync()` is the hook (registered in its constructor, removed in `destroy()`). With no sync target it does nothing. Otherwise it calls `requestSync()`, so concurrent reads share one sync and a sync already running is followed by a fresh one. For `search_notes` it then runs `SearchEngine.syncTables()` until the full-text cursor reaches the last note change. For `semantic_search_notes` (once the indexer's initial scan is done) it runs `EmbeddingIndexer.maintenance()` until the embedding cursor reaches the last change. Reads by id don't wait for either index. The whole hook is bounded by 30 s (`preReadSyncTimeout`); after that the read proceeds with a warning and the sync carries on in the background. Sync errors and `mustAuthenticate` are also returned as warnings.
- Agents should pass `sync: false` for bulk reads (for example, reading many notes in a row) once one call in the batch has synced. The tool's schema description says so.

## Building the terminal app from the monorepo

The root `postinstall` builds every workspace, including Electron and mobile. Instead, install only the CLI workspace and its dependencies, then compile its closure of workspace packages in dependency order.

```sh
# Node >= 22.19 with corepack (Yarn 4 is pinned by .yarnrc.yml / packageManager)
export ELECTRON_SKIP_BINARY_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL=skip HUSKY=0
corepack enable
yarn workspaces focus joplin            # installs only app-cli + its workspace deps; root postinstall does not run

for w in @joplin/fork-htmlparser2:build @joplin/turndown:build @joplin/turndown-plugin-gfm:build \
	@joplin/fork-uslug:tsc @joplin/utils:tsc @joplin/htmlpack:tsc @joplin/renderer:build @joplin/renderer:tsc \
	@joplin/lib:tsc @joplin/tools:tsc joplin:tsc joplin:build; do
	yarn workspace "${w%:*}" run "${w#*:}" || exit 1
done

# Optional, for a runtime image: drop dev dependencies and other platforms' ONNX binaries
yarn workspaces focus --production joplin
rm -rf packages/app-cli/node_modules/onnxruntime-node/bin/napi-v6/{win32,darwin,linux/arm64}
```

- Entry point: `packages/app-cli/build/main.js`. It resolves modules through the monorepo's `node_modules` and the `packages/*` workspace links, so the runtime needs the whole tree, not just `build/`.
- `@joplin/onenote-converter` (Rust/WASM) is not built; it is only loaded dynamically by the OneNote importer, which won't work in this build.
- The repo's `.dockerignore` is written for the server image and **excludes `packages/app-cli/`**, so a `COPY . .` Docker build won't work. Clone the fork at a pinned commit inside the build stage instead (see below).
- No compilers are needed on linux-x64: sqlite3, sharp, keytar and onnxruntime-node use prebuilt binaries. The build does need `rsync`, which the CLI's `gulp build` uses to copy `app/` to `build/`, and `git` if you clone inside the image. `node:22-bookworm-slim` ships neither.

Measured on haven (6-core i5-8500, 16 GB) in `node:22-bookworm-slim` (Node 22.23), from a clean fetch of commit `cda6b8b02`, with no cache:

| Step | Time | Tree size after |
|---|---|---|
| `yarn workspaces focus joplin` | 61 s | |
| Compile the 12 workspace steps | 43 s | 4.8 GB |
| `focus --production` + ONNX prune | 65 s | 1.2 GB |

The resulting image (`node:22-bookworm-slim` + the pruned tree) is 2.17 GB uncompressed. Inside it, `version` runs, `onnxruntime-node` and `sqlite-vec` load, `server start --service` serves `status`, and `docker stop` (SIGTERM to node as PID 1) exits 0 in 70 ms. A tested multi-stage Dockerfile for Part B:

```dockerfile
FROM node:22-bookworm-slim AS build
ARG JOPLIN_REPO=https://github.com/Veldrovive/joplin.git
ARG JOPLIN_COMMIT
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates rsync && rm -rf /var/lib/apt/lists/*
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1 PUPPETEER_SKIP_DOWNLOAD=1 ONNXRUNTIME_NODE_INSTALL=skip HUSKY=0
WORKDIR /src
RUN git init -q && git remote add origin "$JOPLIN_REPO" \
	&& git fetch -q --depth 1 origin "$JOPLIN_COMMIT" && git checkout -q FETCH_HEAD && rm -rf .git
RUN corepack enable && yarn workspaces focus joplin
RUN for w in @joplin/fork-htmlparser2:build @joplin/turndown:build @joplin/turndown-plugin-gfm:build \
		@joplin/fork-uslug:tsc @joplin/utils:tsc @joplin/htmlpack:tsc @joplin/renderer:build @joplin/renderer:tsc \
		@joplin/lib:tsc @joplin/tools:tsc joplin:tsc joplin:build; do \
		yarn workspace "${w%:*}" run "${w#*:}" || exit 1; \
	done
RUN yarn workspaces focus --production joplin \
	&& rm -rf packages/app-cli/node_modules/onnxruntime-node/bin/napi-v6/win32 \
		packages/app-cli/node_modules/onnxruntime-node/bin/napi-v6/darwin \
		packages/app-cli/node_modules/onnxruntime-node/bin/napi-v6/linux/arm64

FROM node:22-bookworm-slim
COPY --from=build /src /app
ENTRYPOINT ["node", "/app/packages/app-cli/build/main.js"]
# e.g. CMD ["--profile", "/profile", "server", "start", "--service", "--sync-interval", "60"]
```

`JOPLIN_COMMIT` must be a full 40-character SHA (GitHub won't serve a fetch by short SHA). Part B adds tini as planned (signals already work without it), the `user`, the volume and so on. On the host used for development, the same steps without Docker took 54 s (install) and 43 s (compile).

## Running the service

```sh
P=/path/to/profile
J="node packages/app-cli/build/main.js --profile $P"

# One-time profile setup (stop the service first: one process per profile)
$J config api.port 41184
$J config mcp.enabled true
$J config ai.enabled true                       # ai.embedding.enabled defaults to true
for t in search_notes read_note read_image list_notebooks list_tags create_note update_note \
	delete_note manage_tags create_notebook semantic_search_notes; do
	$J config ai.tool.$t.enabled true
done
# Sync target, e.g. Joplin Server: sync.target 9, sync.9.path, sync.9.username, sync.9.password

# Run
$J server start --service --sync-interval 60
```

The server binds `127.0.0.1` only (unchanged). On first start, the indexer downloads the embedding model (`multilingual-e5-small`, 134 MB, from `github.com/joplin/embedding-models`) into `<profile>/cache/ai/embedding-models/`, so the service needs internet access once.

### Endpoints

All endpoints use the existing token (`api.token` in `settings.json`), passed as `?token=…`.

- `POST /mcp?token=…`: Joplin's MCP server (unchanged).
- `POST /services/headless?token=…` with a JSON body (the Data API's existing `services` route only accepts POST):
  - `{"action": "status"}` →
    ```json
    {
      "version": "3.7.1", "profileDir": "…", "uptimeSeconds": 125, "mcpEnabled": true, "apiPort": 41190,
      "sync": {
        "target": "joplinServer", "intervalSeconds": 60, "inProgress": false, "currentStartTime": null,
        "mustAuthenticate": false,
        "last": { "startTime": 1793570288716, "endTime": 1793570288997, "errors": [] }
      },
      "embeddings": {
        "available": true, "modelDownloadStatus": "downloaded", "indexerState": "idle",
        "notesIndexed": 508, "totalNotes": 508
      }
    }
    ```
    Times are Unix milliseconds. `sync.last` is `null` until the first sync completes. `embeddings.available: false` comes with `reason` / `hint` (e.g. `disabled`, `vector-search-unavailable`). For monitoring, check `sync.last.endTime` age, `sync.last.errors`, `sync.mustAuthenticate`, and `notesIndexed` vs `totalNotes`.
  - `{"action": "sync"}` → `{"started": true}` (returns immediately).
  - `{"action": "sync", "wait": true}` → `{"completed": true, "mustAuthenticate": false, "last": {…}}` after the sync finishes.
  - Without a sync target, `sync` returns HTTP 400 `No sync target is configured`.

```sh
TOKEN=$(jq -r '."api.token"' $P/settings.json)
curl -s -X POST "http://127.0.0.1:41184/services/headless?token=$TOKEN" -d '{"action":"status"}'
curl -s -X POST "http://127.0.0.1:41184/services/headless?token=$TOKEN" -d '{"action":"sync","wait":true}'
```

## Test results

All run on 2026-11-01 with Node 22.23.4.

**Unit tests**

- `packages/app-cli`, `yarn test-ci`: 28 suites, 128 tests, all pass. New tests: `app/app.test.ts` (the indexer runs only in long-running modes) and `app/services/headless/HeadlessService.test.ts` (`--sync-interval` parsing, last-sync tracking including errors, coalescing of sync requests, rejection without a sync target).
- `packages/lib`, `yarn test-ci`: 197 suites, 2148 passed, 3 skipped, 5 failed. The 5 failures are in `shim-init-node.test` and `utils/tls/setExtraRootCertificates.test` (`Symbol.asyncDispose is not defined` in the Jest environment). They fail identically on unmodified `dev` (`64167f5fc`). New tests: `BaseApplication.test.ts` (sync and search indexing are scheduled after a change only when `isLongRunning()`) and a case in `registry.test.ts` (the interval override).
- `app/cli-integration-tests.test.ts` is excluded by `test-ci` and is stale upstream: it looks for `app/build/main.js`, which doesn't exist. It was not run.

**End-to-end, without a Joplin Server** (filesystem sync target, profile A = `server start --service --sync-interval 15` on port 41190, profile B = one-shot commands, both sharing one sync directory):

| Check | Result |
|---|---|
| Note created in B + `B sync` → found in A by `search_notes` | 12–21 s (sync interval + search debounce) |
| … then by `semantic_search_notes` | immediately (indexer triggered after the sync) |
| Note created through A's `/mcp` → found by `search_notes` | 2 s |
| … by `semantic_search_notes` | immediately after that |
| … visible in B after `B sync` | 2.4 s after creation (upload ~1 s after save) |
| `sync` with `wait: true` / without / `status` | as documented above |
| SIGTERM while idle | exit 0 in 51 ms |
| SIGTERM during the initial download of 500 notes (95 done) | sync cancelled, exit 0 in 125 ms |
| Restart after that | resumed, all 508 notes downloaded and indexed in ~75 s, no errors |
| Port already in use / `--sync-interval 5` / `abc` | exit 1 with a message |
| First start | model downloaded (134 MB) and loaded; 2/2 notes indexed within ~30 s |

**Sync before MCP reads (PR 3)**, run on 2026-11-10: profile A = `server start --service --sync-interval 3600` (so the timer never fires during the test), B creates or edits a note then runs `B sync`, then A is queried straight away:

| Check | Result |
|---|---|
| `tools/list` | `sync` offered on exactly the 8 flagged tools |
| `search_notes` with `sync: false` | not found (1.2 s) |
| `search_notes` (default) | found (0.5 s, including sync and full-text index update) |
| `semantic_search_notes` (default) on another new note | found (0.4 s) |
| `read_note` after B edited the body, `sync: false` / default | old body (0.00 s) / new body (0.4 s) |
| `read_note` default with nothing to sync | 0.2 s (filesystem target; a Joplin Server round trip adds network latency) |
| `sync: "yes"` | tool error `"sync" must be a boolean` |

Unit tests: `packages/app-cli` `yarn test-ci` 28 suites, 131 tests pass. `packages/lib` `services/ai`, `services/mcp` and `models/ItemChange`: 21 suites, 264 passed, 1 skipped. New tests in `McpServer.test.ts` (the argument is offered only with a hook and only on reading tools; the hook runs by default and not with `sync: false`; a warning or an exception from the hook still returns the note) and `HeadlessService.test.ts` (no sync without a sync target; `search_notes` waits for the full-text index; sync errors become a warning).

**Infra live suite** (`~/infra-management/tests/joplin_mcp`, `JOPLIN_MCP_URL=http://127.0.0.1:41190/mcp JOPLIN_MCP_PROFILE=<A>`): 25 passed, 3 skipped (public tests, no `JOPLIN_MCP_PUBLIC_URL`), 3 deselected (`slow`). `test_semantic_search` **passes**: it only marks itself as an expected failure when the tool returns an error, so with this branch it passes outright (reported as PASSED, not XPASS). `read_notes` is present and enabled (it shares `read_note`'s setting), and the notification test passes. Suggested changes to that suite, not made: make `semantic_search` a real test (create a note, then poll with a related query until it is returned), add `read_notes` to `EXPECTED_TOOLS`, assert 202 for notifications, and add `status`/`sync` endpoint tests (`POST /services/headless`).

## Known issues and notes

- **Full-text search lag:** with `sync: false`, `search_notes` sees a change up to about 10 s after it lands locally, because `SearchEngine.scheduleSyncTables()` debounces by 10 s (same as desktop). In the e2e run, MCP-created notes were searchable after about 2 s, and B→A notes after 12–21 s with a 15 s sync interval. With the default `sync: true` (PR 3), the search waits for the index instead.
- **Pre-read sync cost:** every read with the default `sync: true` makes a round trip to the sync target, even when nothing changed. That was 0.2 s on a local filesystem target; on Joplin Server it depends on latency. It runs a full sync, not a download-only one, so it also uploads pending local changes.
- **Semantic search threshold:** `semantic_search_notes` drops results under Joplin's minimum score (0.83 for the default `normal` limit). Vague queries can return no results even when the note is indexed. That is upstream behaviour, not an indexing gap.
- **Initial scan vs. initial sync:** on a fresh profile, the indexer's initial scan finishes before the first sync downloads anything. Notes downloaded later are indexed from the change feed, so this is harmless (verified: 508/508 indexed after a fresh sync that was interrupted by SIGTERM and resumed).
- **One process per profile** still applies. Don't run one-shot `joplin --profile P …` commands against a profile while the service is running; use the API, MCP or the `sync` endpoint instead.
- `--env dev` disables recurrent sync in `Registry` (upstream behaviour), so run the service in the default `prod` env.
- A `sync` request that races exactly with the start of another sync can return before its own sync ran (the synchronizer reports `alreadyStarted`). The next timer or request sync covers it.
- The `services` route is POST-only, so `status` can't be fetched with a plain GET (e.g. from a browser or a simple HTTP health check).
- The CLI version is still 3.7.1 (`packages/app-cli/package.json`). Joplin Server checks `appMinVersion` (3.7.0 on haven), so this is fine for now. Upstream releases bump it.
- Jest prints "A worker process has failed to exit gracefully" when CLI or lib test files run in parallel workers. This also happens on unmodified `dev` (e.g. `registry.test.js` + `ArrayUtils.test.js`), so it isn't caused by this branch.

## Before upstreaming

- Open as two PRs, in order: PR 1 (`03d0a0de5`, `ac7383143`), then PR 2 (`b20972621`, `eaa486a9f`) plus the glue commit `cda6b8b02`, which belongs with whichever PR merges second.
- Upstream may prefer a separate command (e.g. `joplin service`) over `server start --service`, a GET-able status route instead of `services/headless`, or a different name for `isLongRunning()`.
- Document `--service` and the endpoints in `readme/apps/terminal.md`, and mention the terminal app in `readme/apps/ai_mcp.md` (which says the desktop Web Clipper must be running).
- PR 1 adds about 260 MB of `onnxruntime-node` binaries (all platforms) to the npm `joplin` package's install size. Upstream may want these as `optionalDependencies`, or to fetch them on demand.
- New user-facing strings use `_()` only for the `--sync-interval` validation error; option descriptions follow the existing untranslated style of `server`'s options.
