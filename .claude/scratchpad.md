# Google OAuth Flow Fix

## Problems Identified

### Problem 1: Callback server doesn't work on mobile
`runGoogleOAuthFlow()` starts a callback server on `localhost:8085`. When the user is on mobile Telegram, the browser redirect to `localhost:8085` goes nowhere — the callback server is on the bot's host machine, not the phone. The flow times out after 5 minutes.

### Problem 2: After timeout, asking about Gmail shows a new BYO OAuth URL
When disconnected, `handleStatusAction` calls `startAuth()` and shows a fresh OAuth URL. This creates a second, independent auth flow — confusing when the user already has a valid code from a previous attempt.

### Problem 3: `extractAuthCode` can't parse callback URLs
When the user pastes `http://localhost:8085/oauth2/callback?state=...&code=4/0Afrlep...&scope=...`, the regex `([^\s]+)` grabs everything from "code" onwards including `&scope=...`. It also doesn't handle URL query parameters properly.

### Problem 4: Router doesn't recognize pasted callback URLs as auth codes
The router checks for `gmail code`, `oauth code`, `authorization code` keywords. A bare callback URL or a code like `4/0Afrlep...` doesn't match.

### Problem 5: `detectAction` in email.ts doesn't catch callback URLs
Same issue as the router — if the message contains a callback URL or bare auth code, it falls through to `status`.

## Fixes

### Fix 1: `extractAuthCode` — parse callback URLs + bare codes (email.ts)
- Detect `oauth2/callback` URLs → parse `code` query param with URL API
- Detect bare Google auth codes (pattern: `4/0A...`)
- Extract code between `&` delimiters properly

### Fix 2: Router heuristic — recognize callback URLs and auth codes (router.ts)
- Add pattern for `oauth2/callback` URLs → route as email/auth_code
- Add pattern for bare `4/0A` codes → route as email/auth_code

### Fix 3: `detectAction` — catch callback URLs and bare codes (email.ts)
- Add fallback detection for callback URLs and bare auth codes

### Fix 4: `runGoogleOAuthFlow` — show manual fallback instructions (index.ts)
- In the waiting message, mention that the user can paste the code or URL back if the auto-redirect doesn't work
- In the timeout message, include clearer instructions

### Fix 5: `handleStatusAction` — don't generate new auth URLs inline (email.ts)
- When disconnected, just say "not connected" with instructions to use `/connect`
- Don't call `startAuth()` and show a new BYO URL mid-conversation

## Files to Change
1. `src/skills/email.ts` — extractAuthCode, detectAction, handleStatusAction
2. `src/router.ts` — heuristicIntent
3. `src/index.ts` — runGoogleOAuthFlow messages
