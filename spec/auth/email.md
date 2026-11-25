# Email magic link authentication and account lifecycle

Feed supports **first-party passwordless Email Magic Link authentication** alongside mobile phone SMS verification. Users enter an email address, receive a 15-minute single-use magic link via Resend, confirm 18+ and pick a username on first sign-up for the one-time `100 pts` grant, link or change an email address on an existing account, sign out everywhere, or delete their account with a 30-day email cooldown. Raw email addresses and magic link tokens are modeled with `SecretEmail` and `SecretMagicToken` (`SPEC.md#secrets`), leaving only a keyed HMAC `emailHash` and `declassifyEmailMasked` in public views.

## Story: Request and consume a single-use email magic link safely

> As a player signing in with my email, I want a 15-minute single-use magic link that blocks disposable domains and abuse, supersedes older links on resend, and never stores or leaks my raw email address or link token.

### Only valid non-disposable emails, Turnstile-verified requests, and rate-limited addresses receive a magic link

Requests require a valid non-disposable email address, Cloudflare Turnstile verification, and IP/global abuse checks. Per-email limits enforce a `30 s` resend gap, `5` sends per hour, and `15` sends per day. Issuing a new magic link supersedes any previously open link for the account.

```quint
type Millis = int
type SecretEmail = str
type SecretMagicToken = str

type EmailAccountStatus =
  | EmailUnregistered
  | EmailPendingOnboarding
  | EmailActive
  | EmailDeletedCooldown
  | EmailErased

type MagicLinkStatus =
  | LinkIdle
  | LinkOpen
  | LinkConsumed
  | LinkExpired

type MagicLinkPurpose =
  | PurposeEmailSignIn
  | PurposeEmailLink

type EmailEffect =
  | DispatchMagicLinkEmail({ toEmail: SecretEmail, magicToken: SecretMagicToken, linkPurpose: MagicLinkPurpose })
  | IssueEmailStartingGrant({ grantUserId: str, grantPoints: int })
  | RevokeAllEmailSessions({ sessionUserId: str, toEpoch: int })

type EmailAuth = {
  status: EmailAccountStatus,
  userId: str,
  username: str,
  isReviewer: bool,
  ageConfirmed: bool,
  termsAccepted: bool,
  emailVerified: bool,
  emailHash: str,
  emailMasked: str,
  emailReleased: bool,
  pointsBalance: int,
  startingGrantIssued: bool,
  startingGrantCount: int,
  sessionsEpoch: int,
  lastSignInAt: Millis,
  deletedAt: Millis,
  cooldownEndsAt: Millis,
  linkStatus: MagicLinkStatus,
  linkPurpose: MagicLinkPurpose,
  pendingEmail: SecretEmail,
  pendingEmailHash: str,
  pendingEmailMasked: str,
  pendingToken: SecretMagicToken,
  pendingTokenHash: str,
  linkSentAt: Millis,
  linkExpiresAt: Millis,
  consumedCount: int,
  hasSentBefore: bool,
  lastSentAt: Millis,
  hourWindowStart: Millis,
  hourSends: int,
  dayWindowStart: Millis,
  daySends: int,
  now: Millis,
}

type PublicEmailAccountView = {
  viewUserId: str,
  viewUsername: str,
  viewStatus: EmailAccountStatus,
  viewEmailHash: str,
  viewEmailMasked: str,
  viewAgeConfirmed: bool,
  viewIsReviewer: bool,
  viewStartingGrantIssued: bool,
  viewSessionsEpoch: int,
}

type EmailStep = {
  state: EmailAuth,
  out: List[EmailEffect],
}

pure val emailResendGapMs: Millis = 30000
pure val magicLinkLifetimeMs: Millis = 900000
pure val recentSignInWindowMs: Millis = 600000
pure val hourMs: Millis = 3600000
pure val dayMs: Millis = 86400000
pure val emailCooldownMs: Millis = 2592000000
pure val maxEmailSendsPerHour: int = 5
pure val maxEmailSendsPerDay: int = 15
pure val startingGrantPoints: int = 100

pure val initial: EmailAuth = {
  status: EmailUnregistered,
  userId: "",
  username: "",
  isReviewer: false,
  ageConfirmed: false,
  termsAccepted: false,
  emailVerified: false,
  emailHash: "",
  emailMasked: "",
  emailReleased: false,
  pointsBalance: 0,
  startingGrantIssued: false,
  startingGrantCount: 0,
  sessionsEpoch: 0,
  lastSignInAt: 0,
  deletedAt: 0,
  cooldownEndsAt: 0,
  linkStatus: LinkIdle,
  linkPurpose: PurposeEmailSignIn,
  pendingEmail: "",
  pendingEmailHash: "",
  pendingEmailMasked: "",
  pendingToken: "",
  pendingTokenHash: "",
  linkSentAt: 0,
  linkExpiresAt: 0,
  consumedCount: 0,
  hasSentBefore: false,
  lastSentAt: 0,
  hourWindowStart: 0,
  hourSends: 0,
  dayWindowStart: 0,
  daySends: 0,
  now: 0,
}

pure def declassifyEmailMasked(email: SecretEmail): str =
  if (email == "alice@example.com") "a***@example.com"
  else if (email == "bob@example.com") "b***@example.com"
  else if (email == "") ""
  else "u***@example.com"

pure def publicEmailAccountView(s: EmailAuth): PublicEmailAccountView = {
  viewUserId: s.userId,
  viewUsername: s.username,
  viewStatus: s.status,
  viewEmailHash: s.emailHash,
  viewEmailMasked: s.emailMasked,
  viewAgeConfirmed: s.ageConfirmed,
  viewIsReviewer: s.isReviewer,
  viewStartingGrantIssued: s.startingGrantIssued,
  viewSessionsEpoch: s.sessionsEpoch,
}

pure def inActiveEmailHourWindow(s: EmailAuth): bool =
  s.hasSentBefore and s.now < s.hourWindowStart + hourMs

pure def inActiveEmailDayWindow(s: EmailAuth): bool =
  s.hasSentBefore and s.now < s.dayWindowStart + dayMs

pure def currentEmailHourSends(s: EmailAuth): int =
  if (inActiveEmailHourWindow(s)) s.hourSends else 0

pure def currentEmailDaySends(s: EmailAuth): int =
  if (inActiveEmailDayWindow(s)) s.daySends else 0

pure def emailResendGapOk(s: EmailAuth): bool =
  not(s.hasSentBefore) or s.now >= s.lastSentAt + emailResendGapMs

pure def withinEmailSendRateLimits(s: EmailAuth): bool =
  emailResendGapOk(s)
    and currentEmailHourSends(s) < maxEmailSendsPerHour
    and currentEmailDaySends(s) < maxEmailSendsPerDay

pure def emailSendEligible(
  emailAllowed: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool
): bool =
  emailAllowed and turnstilePassed and ipAndGlobalAllowed

pure def openMagicLink(
  purpose: MagicLinkPurpose,
  s: EmailAuth,
  email: SecretEmail,
  emailHash: str,
  magicToken: SecretMagicToken,
  tokenHash: str
): EmailStep = {
  val nextHourStart = if (inActiveEmailHourWindow(s)) s.hourWindowStart else s.now
  val nextDayStart = if (inActiveEmailDayWindow(s)) s.dayWindowStart else s.now
  {
    state: {
      ...s,
      linkStatus: LinkOpen,
      linkPurpose: purpose,
      pendingEmail: email,
      pendingEmailHash: emailHash,
      pendingEmailMasked: declassifyEmailMasked(email),
      pendingToken: magicToken,
      pendingTokenHash: tokenHash,
      linkSentAt: s.now,
      linkExpiresAt: s.now + magicLinkLifetimeMs,
      hasSentBefore: true,
      lastSentAt: s.now,
      hourWindowStart: nextHourStart,
      hourSends: currentEmailHourSends(s) + 1,
      dayWindowStart: nextDayStart,
      daySends: currentEmailDaySends(s) + 1,
    },
    out: List(DispatchMagicLinkEmail({ toEmail: email, magicToken: magicToken, linkPurpose: purpose })),
  }
}

pure def canRequestMagicLink(
  s: EmailAuth,
  emailHash: str,
  tokenHash: str,
  emailAllowed: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool
): bool =
  emailHash != ""
    and tokenHash != ""
    and not(s.isReviewer)
    and (s.status == EmailUnregistered or (s.status == EmailActive and emailHash == s.emailHash))
    and emailSendEligible(emailAllowed, turnstilePassed, ipAndGlobalAllowed)
    and withinEmailSendRateLimits(s)

pure def requestMagicLink(
  s: EmailAuth,
  email: SecretEmail,
  emailHash: str,
  magicToken: SecretMagicToken,
  tokenHash: str,
  emailAllowed: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool
): EmailStep =
  openMagicLink(PurposeEmailSignIn, s, email, emailHash, magicToken, tokenHash)
```

### Magic links are single-use, expire in 15 minutes, and purge pending secrets on consume or expiry

Consuming a magic link requires an open, unexpired link whose SHA-256 `pendingTokenHash` matches the presented token digest. Consumption atomically clears pending secrets, marks the link `LinkConsumed`, and increments `consumedCount` so replays are refused.

```quint
pure def clearLink(nextLinkStatus: MagicLinkStatus, s: EmailAuth): EmailAuth = {
  ...s,
  linkStatus: nextLinkStatus,
  pendingEmail: "",
  pendingEmailHash: "",
  pendingEmailMasked: "",
  pendingToken: "",
  pendingTokenHash: "",
}

pure def applyMagicLinkConsume(assignedUserId: str, s: EmailAuth): EmailStep = {
  val cleared = clearLink(LinkConsumed, s)
  val nextEpoch = s.sessionsEpoch + 1
  val nextConsumed = s.consumedCount + 1
  if (s.status == EmailUnregistered)
    {
      state: {
        ...cleared,
        status: EmailPendingOnboarding,
        userId: assignedUserId,
        emailVerified: true,
        emailHash: s.pendingEmailHash,
        emailMasked: s.pendingEmailMasked,
        emailReleased: false,
        sessionsEpoch: 1,
        lastSignInAt: s.now,
        consumedCount: nextConsumed,
      },
      out: List(),
    }
  else if (s.linkPurpose == PurposeEmailLink)
    {
      state: {
        ...cleared,
        emailVerified: true,
        emailHash: s.pendingEmailHash,
        emailMasked: s.pendingEmailMasked,
        sessionsEpoch: nextEpoch,
        lastSignInAt: s.now,
        consumedCount: nextConsumed,
      },
      out: List(RevokeAllEmailSessions({ sessionUserId: s.userId, toEpoch: nextEpoch })),
    }
  else
    {
      state: {
        ...cleared,
        lastSignInAt: s.now,
        consumedCount: nextConsumed,
      },
      out: List(),
    }
}

pure def canConsumeMagicLink(s: EmailAuth, presentedTokenHash: str, assignedUserId: str): bool =
  s.linkStatus == LinkOpen
    and s.now < s.linkExpiresAt
    and presentedTokenHash != ""
    and presentedTokenHash == s.pendingTokenHash
    and (s.status == EmailUnregistered implies assignedUserId != "")

pure def consumeMagicLink(s: EmailAuth, presentedTokenHash: str, assignedUserId: str): EmailStep =
  applyMagicLinkConsume(assignedUserId, s)

pure def canExpireMagicLink(s: EmailAuth): bool =
  s.linkStatus == LinkOpen and s.now >= s.linkExpiresAt

pure def expireMagicLink(s: EmailAuth): EmailStep =
  { state: clearLink(LinkExpired, s), out: List() }
```

## Story: Onboard once, link or change email, sign out everywhere, or delete after cooldown

> As an email-verified player, I want to pick a username, confirm 18+ and Terms to receive my one-time 100 pts grant, link or update my email address safely, sign out everywhere, and delete my account with a 30-day email cooldown.

### Email onboarding requires username, 18+ attestation, and Terms, and issues 100 pts once per verified email

New email sign-ups remain in `EmailPendingOnboarding` until `completeEmailOnboarding` records a non-empty `username`, `ageConfirmed == true`, and `termsAccepted == true`. Completing onboarding activates the account and emits the one-time `100 pts` starting grant.

```quint
pure def canCompleteEmailOnboarding(
  s: EmailAuth,
  username: str,
  ageConfirmed: bool,
  termsAccepted: bool
): bool =
  s.status == EmailPendingOnboarding
    and s.emailVerified
    and not(s.isReviewer)
    and not(s.startingGrantIssued)
    and username != ""
    and ageConfirmed
    and termsAccepted

pure def completeEmailOnboarding(
  s: EmailAuth,
  username: str,
  ageConfirmed: bool,
  termsAccepted: bool
): EmailStep = {
  val nextBalance = s.pointsBalance + startingGrantPoints
  {
    state: {
      ...s,
      status: EmailActive,
      username: username,
      ageConfirmed: true,
      termsAccepted: true,
      pointsBalance: nextBalance,
      startingGrantIssued: true,
      startingGrantCount: s.startingGrantCount + 1,
    },
    out: List(IssueEmailStartingGrant({ grantUserId: s.userId, grantPoints: startingGrantPoints })),
  }
}
```

### Linking or changing an email requires an active non-reviewer account, an unused address, and recent sign-in or first link

```quint
pure def canRequestLinkEmail(
  s: EmailAuth,
  newEmailHash: str,
  tokenHash: str,
  recentSignInOrFirstLink: bool,
  newEmailUnused: bool,
  emailAllowed: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool
): bool =
  s.status == EmailActive
    and not(s.isReviewer)
    and newEmailHash != ""
    and newEmailHash != s.emailHash
    and tokenHash != ""
    and recentSignInOrFirstLink
    and newEmailUnused
    and emailSendEligible(emailAllowed, turnstilePassed, ipAndGlobalAllowed)
    and withinEmailSendRateLimits(s)

pure def requestLinkEmail(
  s: EmailAuth,
  newEmail: SecretEmail,
  newEmailHash: str,
  magicToken: SecretMagicToken,
  tokenHash: str,
  recentSignInOrFirstLink: bool,
  newEmailUnused: bool,
  emailAllowed: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool
): EmailStep =
  openMagicLink(PurposeEmailLink, s, newEmail, newEmailHash, magicToken, tokenHash)
```

### Sign out everywhere bumps `sessionsEpoch`, and self-serve deletion holds the email hash for 30 days

Self-serve account deletion requires a recent sign-in within the last `10` minutes, revokes all sessions immediately, and retains `emailHash` during the 30-day cooldown. Once the 30-day cooldown elapses, `releaseEmailHash` erases `emailHash` and marks the address free.

```quint
pure def canSignOutEmailEverywhere(s: EmailAuth): bool =
  s.status == EmailActive

pure def signOutEmailEverywhere(s: EmailAuth): EmailStep = {
  val nextEpoch = s.sessionsEpoch + 1
  {
    state: { ...s, sessionsEpoch: nextEpoch },
    out: List(RevokeAllEmailSessions({ sessionUserId: s.userId, toEpoch: nextEpoch })),
  }
}

pure def canDeleteEmailAccount(s: EmailAuth): bool =
  s.status == EmailActive
    and not(s.isReviewer)
    and s.emailVerified
    and s.now - s.lastSignInAt <= recentSignInWindowMs

pure def deleteEmailAccount(s: EmailAuth): EmailStep = {
  val cleared = clearLink(LinkIdle, s)
  val nextEpoch = s.sessionsEpoch + 1
  {
    state: {
      ...cleared,
      status: EmailDeletedCooldown,
      username: "",
      deletedAt: s.now,
      cooldownEndsAt: s.now + emailCooldownMs,
      sessionsEpoch: nextEpoch,
    },
    out: List(RevokeAllEmailSessions({ sessionUserId: s.userId, toEpoch: nextEpoch })),
  }
}

pure def canReleaseEmailHash(s: EmailAuth): bool =
  s.status == EmailDeletedCooldown and s.now >= s.cooldownEndsAt

pure def releaseEmailHash(s: EmailAuth): EmailStep =
  {
    state: {
      ...s,
      status: EmailErased,
      emailHash: "",
      emailMasked: "",
      emailVerified: false,
      emailReleased: true,
    },
    out: List(),
  }

pure def canElapse(s: EmailAuth, elapsed: Millis): bool =
  elapsed > 0

pure def elapse(s: EmailAuth, elapsed: Millis): EmailStep =
  { state: { ...s, now: s.now + elapsed }, out: List() }
```

## Story: Enforce inductive email-auth invariants and verify reachable milestones

### Active accounts, single-use links, one-time grants, cooldown release, and secret clearing hold inductively

```quint
pure def alwaysClockAndLinkValid(s: EmailAuth): bool =
  s.now >= 0
    and s.sessionsEpoch >= 0
    and s.pointsBalance >= 0
    and s.consumedCount >= 0
    and 0 <= s.lastSignInAt and s.lastSignInAt <= s.now
    and 0 <= s.deletedAt and s.deletedAt <= s.now
    and 0 <= s.hourSends and s.hourSends <= maxEmailSendsPerHour
    and 0 <= s.daySends and s.daySends <= maxEmailSendsPerDay
    and (s.hasSentBefore implies (
      0 <= s.hourWindowStart and s.hourWindowStart <= s.now
        and 0 <= s.dayWindowStart and s.dayWindowStart <= s.now
        and 0 <= s.lastSentAt and s.lastSentAt <= s.now
    ))
    and (s.linkStatus == LinkOpen implies (
      s.hasSentBefore
        and s.linkSentAt <= s.now
        and s.linkExpiresAt == s.linkSentAt + magicLinkLifetimeMs
        and s.pendingEmailHash != ""
        and s.pendingTokenHash != ""
    ))
    and (s.linkStatus != LinkOpen implies (
      s.pendingEmail == ""
        and s.pendingEmailHash == ""
        and s.pendingEmailMasked == ""
        and s.pendingToken == ""
        and s.pendingTokenHash == ""
    ))
    and ((s.linkStatus == LinkOpen and s.linkPurpose == PurposeEmailLink) implies (
      s.status == EmailActive and not(s.isReviewer) and s.pendingEmailHash != s.emailHash
    ))
    and ((s.linkStatus == LinkOpen and s.linkPurpose == PurposeEmailSignIn) implies (
      s.status == EmailUnregistered or (s.status == EmailActive and not(s.isReviewer) and s.pendingEmailHash == s.emailHash)
    ))

pure def alwaysActiveEmailAccountVerifiedAndAdult(s: EmailAuth): bool =
  ((s.status == EmailActive and not(s.isReviewer)) implies (
    s.emailVerified
      and s.emailHash != ""
      and s.ageConfirmed
      and s.termsAccepted
      and s.username != ""
      and s.userId != ""
      and s.sessionsEpoch >= 1
  ))
    and (s.status == EmailPendingOnboarding implies (
      not(s.isReviewer)
        and s.linkStatus != LinkOpen
        and s.emailVerified
        and s.emailHash != ""
        and s.userId != ""
        and not(s.startingGrantIssued)
        and s.startingGrantCount == 0
    ))
    and (s.status == EmailUnregistered implies (
      not(s.isReviewer)
        and not(s.emailVerified)
        and s.emailHash == ""
        and s.userId == ""
        and s.username == ""
        and not(s.startingGrantIssued)
        and s.startingGrantCount == 0
        and not(s.emailReleased)
    ))
    and not(s.isReviewer)

pure def alwaysEmailStartingGrantAtMostOnce(s: EmailAuth): bool =
  0 <= s.startingGrantCount
    and s.startingGrantCount <= 1
    and (s.startingGrantIssued iff (s.startingGrantCount == 1))
    and (s.startingGrantIssued implies not(s.isReviewer))

pure def alwaysEmailHashReleasedOnlyAfterCooldown(s: EmailAuth): bool =
  (s.status == EmailDeletedCooldown implies (
    not(s.isReviewer)
      and s.linkStatus == LinkIdle
      and s.emailVerified
      and s.emailHash != ""
      and not(s.emailReleased)
      and s.cooldownEndsAt == s.deletedAt + emailCooldownMs
  ))
    and (s.status == EmailErased implies (
      not(s.isReviewer)
        and s.linkStatus == LinkIdle
        and s.emailReleased
        and s.emailHash == ""
        and s.emailMasked == ""
        and not(s.emailVerified)
        and s.now >= s.cooldownEndsAt
        and s.cooldownEndsAt == s.deletedAt + emailCooldownMs
    ))
    and ((s.status != EmailErased) implies not(s.emailReleased))

pure def alwaysUnregisteredAndOnboardingSessionEpoch(s: EmailAuth): bool =
  (s.status == EmailUnregistered implies s.sessionsEpoch == 0)
    and (s.status == EmailPendingOnboarding implies s.sessionsEpoch >= 1)

pure def stepSingleUseAndMonotonicity(
  before: EmailAuth,
  via: str,
  after: EmailAuth,
  out: List[EmailEffect]
): bool =
  after.consumedCount >= before.consumedCount
    and after.startingGrantCount >= before.startingGrantCount
    and after.sessionsEpoch >= before.sessionsEpoch
    and (via == "consumeMagicLink" implies (
      before.linkStatus == LinkOpen
        and before.now < before.linkExpiresAt
        and after.linkStatus == LinkConsumed
        and after.pendingTokenHash == ""
        and after.consumedCount == before.consumedCount + 1
    ))
    and (via == "completeEmailOnboarding" implies (
      before.status == EmailPendingOnboarding
        and after.status == EmailActive
        and after.pointsBalance == before.pointsBalance + startingGrantPoints
        and out == List(IssueEmailStartingGrant({ grantUserId: after.userId, grantPoints: startingGrantPoints }))
    ))
    and (via == "deleteEmailAccount" implies (
      before.status == EmailActive
        and not(before.isReviewer)
        and before.now - before.lastSignInAt <= recentSignInWindowMs
        and after.status == EmailDeletedCooldown
    ))

pure def lawBlockedEmailSendRefused(
  s: EmailAuth,
  emailHash: str,
  tokenHash: str,
  emailAllowed: bool,
  turnstilePassed: bool,
  ipAndGlobalAllowed: bool
): bool =
  (not(emailAllowed) or not(turnstilePassed) or not(ipAndGlobalAllowed)) implies
    not(canRequestMagicLink(s, emailHash, tokenHash, emailAllowed, turnstilePassed, ipAndGlobalAllowed))

pure def lawExpiredOrReplayedLinkRefused(
  s: EmailAuth,
  presentedTokenHash: str,
  assignedUserId: str
): bool =
  (s.linkStatus != LinkOpen or s.now >= s.linkExpiresAt or presentedTokenHash != s.pendingTokenHash) implies
    not(canConsumeMagicLink(s, presentedTokenHash, assignedUserId))

pure def lawCooldownBlocksEarlyEmailRelease(s: EmailAuth): bool =
  (alwaysEmailHashReleasedOnlyAfterCooldown(s) and s.now < s.cooldownEndsAt) implies
    not(canReleaseEmailHash(s))

pure def sometimesEmailSignedUpWithStartingGrant(s: EmailAuth): bool =
  s.status == EmailActive and s.startingGrantIssued and s.pointsBalance == startingGrantPoints

pure def sometimesEmailLinkedToAccount(s: EmailAuth): bool =
  s.status == EmailActive and s.emailHash == "eh_02" and s.startingGrantCount == 1

pure def sometimesMagicLinkExpired(s: EmailAuth): bool =
  s.linkStatus == LinkExpired and s.pendingTokenHash == ""

pure def sometimesEmailDeletedAndReleased(s: EmailAuth): bool =
  s.status == EmailErased and s.emailReleased and s.emailHash == ""

pure def sometimesEmailSignedOutEverywhere(s: EmailAuth): bool =
  s.status == EmailActive and s.sessionsEpoch >= 2
```

### Simulation samples and witness journeys cover onboarding, linking, expiry, deletion cooldown, and sign-out

```quint
pure val emailValues: Set[SecretEmail] = Set("alice@example.com", "bob@example.com")
pure val newEmailValues: Set[SecretEmail] = Set("bob@example.com")
pure val emailHashValues: Set[str] = Set("eh_01", "eh_02")
pure val newEmailHashValues: Set[str] = Set("eh_02")
pure val magicTokenValues: Set[SecretMagicToken] = Set("tok_secret_1", "tok_secret_2")
pure val tokenHashValues: Set[str] = Set("th_01", "th_02")
pure val presentedTokenHashValues: Set[str] = Set("th_01", "th_02", "th_bad")
pure val assignedUserIdValues: Set[str] = Set("user-1", "user-2")
pure val usernameValues: Set[str] = Set("alice", "bob")
pure val elapsedValues: Set[Millis] = Set(0, 30000, 900000, 3600000, 86400000, 2592000000)

pure val eval_witness_sometimesEmailSignedUpWithStartingGrant = (
  ("requestMagicLink", "alice@example.com", "eh_01", "tok_secret_1", "th_01", true, true, true),
  ("consumeMagicLink", "th_01", "user-1"),
  ("completeEmailOnboarding", "alice", true, true)
)

pure val eval_witness_sometimesEmailLinkedToAccount = (
  ("requestMagicLink", "alice@example.com", "eh_01", "tok_secret_1", "th_01", true, true, true),
  ("consumeMagicLink", "th_01", "user-1"),
  ("completeEmailOnboarding", "alice", true, true),
  ("elapse", 30000),
  ("requestLinkEmail", "bob@example.com", "eh_02", "tok_secret_2", "th_02", true, true, true, true, true),
  ("consumeMagicLink", "th_02", "user-1")
)

pure val eval_witness_sometimesMagicLinkExpired = (
  ("requestMagicLink", "alice@example.com", "eh_01", "tok_secret_1", "th_01", true, true, true),
  ("elapse", 900000),
  "expireMagicLink"
)

pure val eval_witness_sometimesEmailDeletedAndReleased = (
  ("requestMagicLink", "alice@example.com", "eh_01", "tok_secret_1", "th_01", true, true, true),
  ("consumeMagicLink", "th_01", "user-1"),
  ("completeEmailOnboarding", "alice", true, true),
  "deleteEmailAccount",
  ("elapse", 2592000000),
  "releaseEmailHash"
)

pure val eval_witness_sometimesEmailSignedOutEverywhere = (
  ("requestMagicLink", "alice@example.com", "eh_01", "tok_secret_1", "th_01", true, true, true),
  ("consumeMagicLink", "th_01", "user-1"),
  ("completeEmailOnboarding", "alice", true, true),
  "signOutEmailEverywhere"
)
```
