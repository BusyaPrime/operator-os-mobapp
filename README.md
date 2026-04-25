# Operator-OS Mobile

React Native / Expo client for the [Operator-OS](https://github.com/BusyaPrime/operator-os-dev) platform — submit prompts to a connected Claude Code agent and watch the response stream live.

## Status

Phase 3.4 — first installable APK. Auth flow (Google Sign-In), task submission, and live SSE streaming all wired against the production backend.

## Tech

- Expo SDK 54 + React Native 0.81 + React 19 + TypeScript
- Zustand for state (auth / task / dashboard stores)
- @react-navigation v7 (stack + bottom tabs)
- @microsoft/fetch-event-source for SSE with Bearer auth + Last-Event-ID resume
- @react-native-google-signin/google-signin v16 (Credential Manager)
- expo-secure-store for refresh-token persistence
- Zod-validated env + contracts (inlined from the backend monorepo)

## Repo layout

```
src/
  auth/            Google Sign-In wrapper + Keychain token storage
  components/      ScreenShell, SectionCard, StatusPill (theme primitives)
  config/          Env-var schemas (mobile.ts is the active one;
                   api/auth-gateway/desktop-agent are inlined for
                   shared types only — not consumed at runtime)
  contracts/       Zod schemas + TS types shared with the backend api
                   (inlined verbatim from the operator-os-dev monorepo)
  mocks/           Local fallback dashboard data
  navigation/      RootNavigator, RootTabs, TasksStack, types
  screens/         12 screens incl. SignIn, Tasks (submit + stream),
                   Home/Devices/Sessions/Costs/Settings
  services/        api-client, auth-client, authenticated-api-client,
                   sse-client, task-api-client
  state/           auth-store, task-store, operator-store (Zustand)
  theme/           tokens, navigation-theme
App.tsx            Entry — NavigationContainer + RootNavigator
index.ts           Expo-managed entry shim
```

## Running locally

```bash
npm install
npm start                 # Expo dev server (Metro)
# then press `a` for Android, `w` for web
```

For local auth flow, copy `.env.example` to `.env.production`, fill in your OAuth Web Client ID, and use the `--variant production` flag in Expo / build.

## Building installable APK

This project uses [EAS Build](https://docs.expo.dev/build/introduction/) for cloud-managed Android builds.

```bash
npx eas-cli login                                # one-time
npx eas-cli build --platform android --profile preview
```

`preview` profile produces an `.apk` for direct install (internal distribution). `production` profile produces an `.aab` for Play Store submission.

The `eas.json` `env` blocks bake the production backend URLs and OAuth Web Client ID into each build.

## Backend

The mobile app talks to a separate Cloud Run backend that lives in [BusyaPrime/operator-os-dev](https://github.com/BusyaPrime/operator-os-dev). That repo hosts the Fastify api, the auth-gateway, and the desktop-agent that runs the actual `claude` CLI subprocess. The `src/contracts/` and `src/config/` directories here are inlined copies of the corresponding `packages/` from that monorepo so the mobile app stays independently buildable without a workspace dependency.

## Tests

```bash
npm run typecheck          # tsc --noEmit
npm test                   # vitest (111 tests covering screens / state
                           # / sse client / task helpers / etc.)
```

## License

UNLICENSED — internal project.
